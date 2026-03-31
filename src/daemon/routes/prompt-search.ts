import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore, type SearchResult } from "../../db/promoted.js";
import { RecallStore, type RecallFeedback } from "../../db/recall.js";
import { selectMemoryHintsWithinBudget } from "../../hooks/memory-context.js";
import { validateCwd } from "../validate-cwd.js";

const CANDIDATE_LIMIT_MULTIPLIER = 5;
const MIN_CANDIDATE_LIMIT = 10;

type RankedPromptSearchResult = SearchResult & {
  baseScore: number;
  finalScore: number;
  usageBoost: number;
  unusedPenalty: number;
  cooledDown: boolean;
  feedback: RecallFeedback;
};

function compareRankedResults(a: RankedPromptSearchResult, b: RankedPromptSearchResult): number {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return a.createdAt.localeCompare(b.createdAt);
}

function computeBaseScore(
  result: SearchResult,
  querySessionId: string | null | undefined,
  now: number,
  halfLife: number,
  crossSessionAffinity: number,
): number {
  const createdAtMs = new Date(result.createdAt).getTime();
  const ageHours = Number.isFinite(createdAtMs)
    ? Math.max(0, (now - createdAtMs) / 3_600_000)
    : 0;
  const recencyFactor = Math.pow(0.5, ageHours / halfLife);

  let sessionAffinity: number;
  if (querySessionId == null) {
    sessionAffinity = 1.0;
  } else if (result.sessionId === querySessionId) {
    sessionAffinity = 1.0;
  } else {
    sessionAffinity = crossSessionAffinity;
  }

  return Math.abs(result.rank) * recencyFactor * sessionAffinity;
}

function computeUsageBoost(usageCount: number, boost: number, smoothing: number): number {
  if (usageCount <= 0 || boost <= 0) return 1.0;

  const denominator = usageCount + Math.max(0, smoothing);
  if (denominator <= 0) return 1.0;
  return 1.0 + boost * (usageCount / denominator);
}

function isWithinCooldown(lastSurfacedAt: string | null, now: number, cooldownWindowHours: number): boolean {
  if (!lastSurfacedAt || cooldownWindowHours <= 0) return false;
  const surfacedAt = new Date(lastSurfacedAt).getTime();
  if (!Number.isFinite(surfacedAt)) return false;
  return now - surfacedAt < cooldownWindowHours * 3_600_000;
}

function rankResults(
  results: SearchResult[],
  feedbackById: Map<string, RecallFeedback>,
  options: {
    querySessionId: string | null | undefined;
    now: number;
    halfLife: number;
    crossSessionAffinity: number;
    recallUsageBoost: number;
    recallUsageSmoothing: number;
    surfacingCooldownWindow: number;
    unusedSurfacingPenalty: number;
  },
): RankedPromptSearchResult[] {
  return results
    .map((result) => {
      const feedback = feedbackById.get(result.id) ?? {
        usageCount: 0,
        surfacingCount: 0,
        lastSurfacedAt: null,
      };
      const baseScore = computeBaseScore(
        result,
        options.querySessionId,
        options.now,
        options.halfLife,
        options.crossSessionAffinity,
      );
      const usageBoost = computeUsageBoost(
        feedback.usageCount,
        options.recallUsageBoost,
        options.recallUsageSmoothing,
      );
      const unusedPenalty = feedback.usageCount === 0
        ? feedback.surfacingCount * Math.max(0, options.unusedSurfacingPenalty)
        : 0;

      return {
        ...result,
        baseScore,
        finalScore: baseScore * usageBoost - unusedPenalty,
        usageBoost,
        unusedPenalty,
        cooledDown: isWithinCooldown(
          feedback.lastSurfacedAt,
          options.now,
          options.surfacingCooldownWindow,
        ),
        feedback,
      };
    })
    .sort(compareRankedResults);
}

function applyCooldown(
  results: RankedPromptSearchResult[],
  minScore: number,
  resurfaceMargin: number,
): RankedPromptSearchResult[] {
  const eligible = results.filter((result) => result.finalScore >= minScore);
  if (eligible.length === 0) return [];

  const bestNonCooled = eligible.find((result) => !result.cooledDown);
  if (!bestNonCooled) return [eligible[0]];

  return eligible.filter((result) => {
    if (!result.cooledDown) return true;
    return result.finalScore >= bestNonCooled.finalScore + Math.max(0, resurfaceMargin);
  });
}

/** Typed request for /prompt-search daemon route. */
export interface PromptSearchRequest {
  query: string;
  cwd: string;
  session_id?: string;
  learningInstructionBytes?: number;
  logSurfacing?: boolean;
  debug?: boolean;
}

function validatePromptSearchInput(input: unknown): PromptSearchRequest {
  if (typeof input !== "object" || input == null) {
    throw new Error("Request body must be a JSON object");
  }

  const obj = input as Record<string, unknown>;
  if (typeof obj.query !== "string") {
    throw new Error("Missing or invalid 'query' field");
  }
  if (typeof obj.cwd !== "string") {
    throw new Error("Missing or invalid 'cwd' field");
  }

  return {
    query: obj.query,
    cwd: obj.cwd,
    session_id: obj.session_id ? String(obj.session_id) : undefined,
    learningInstructionBytes:
      obj.learningInstructionBytes !== undefined
        ? Math.max(0, Math.floor(Number(obj.learningInstructionBytes) || 0))
        : undefined,
    logSurfacing: obj.logSurfacing !== false,
    debug: obj.debug === true,
  };
}

export function createPromptSearchHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    let input: PromptSearchRequest;
    try {
      input = validatePromptSearchInput(JSON.parse(body || "{}"));
    } catch {
      // Invalid request — return empty hints (not 400) so callers treat this as "no suggestions"
      sendJson(res, 200, { hints: [] });
      return;
    }

    const { query, session_id, cwd, learningInstructionBytes, logSurfacing, debug: isDebug } = input;

    // Redundant check (validatePromptSearchInput should have already caught these),
    // but kept for defensive programming.
    if (!query || !cwd) {
      sendJson(res, 200, { hints: [] });
      return;
    }

    let validatedCwd: string;
    try {
      validatedCwd = validateCwd(cwd);
    } catch {
      sendJson(res, 200, { hints: [] });
      return;
    }

    const dbPath = projectDbPath(validatedCwd);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { hints: [] });
      return;
    }

    let db: DatabaseSync | undefined;
    let openedDbPath: string | null = null;
    try {
      db = getLcmConnection(dbPath);
      openedDbPath = dbPath;
      runLcmMigrations(db);

      const store = new PromotedStore(db);
      const maxResults = config.restoration.promptSearchMaxResults;
      const minScore = config.restoration.promptSearchMinScore;
      const snippetLength = config.restoration.promptSnippetLength;
      const maxInjectedMemoryBytes = config.restoration.maxInjectedMemoryBytes;
      const reservedForLearningInstruction = config.restoration.reservedForLearningInstruction;
      const maxInjectedMemoryItems = config.restoration.maxInjectedMemoryItems;
      const dedupMinPrefix = config.restoration.dedupMinPrefix;
      const halfLife = config.restoration.recencyHalfLifeHours;
      const crossSessionAffinity = config.restoration.crossSessionAffinity;
      const recallUsageBoost = config.restoration.recallUsageBoost;
      const recallUsageSmoothing = config.restoration.recallUsageSmoothing;
      const surfacingCooldownWindow = config.restoration.surfacingCooldownWindow;
      const resurfaceMargin = config.restoration.resurfaceMargin;
      const unusedSurfacingPenalty = config.restoration.unusedSurfacingPenalty;

      const targetHintCount = Math.max(maxResults, maxInjectedMemoryItems);
      const candidateLimit = Math.max(targetHintCount * CANDIDATE_LIMIT_MULTIPLIER, MIN_CANDIDATE_LIMIT);
      const results = store.search(query, candidateLimit);
      const recallStore = new RecallStore(db);

      const now = Date.now();
      const feedbackById = recallStore.getFeedback(results.map((result) => result.id));
      const ranked = rankResults(results, feedbackById, {
          querySessionId: session_id,
          now,
          halfLife,
          crossSessionAffinity,
          recallUsageBoost,
          recallUsageSmoothing,
          surfacingCooldownWindow,
          unusedSurfacingPenalty,
        });
      const filtered = applyCooldown(
        ranked,
        minScore,
        resurfaceMargin,
      );

      // Pass the full filtered list (not sliced to maxResults) so the budget
      // selector can choose the best-fitting subset after dedup and truncation.
      const selection = selectMemoryHintsWithinBudget(
        filtered.map((result) => ({
          id: result.id,
          hint: result.content.length > snippetLength
            ? result.content.slice(0, snippetLength) + "..."
            : result.content,
        })),
        {
          totalByteBudget: maxInjectedMemoryBytes,
          reservedForLearningInstruction,
          learningInstructionBytes: learningInstructionBytes ?? 0,
          maxEmitted: maxInjectedMemoryItems,
          dedupMinPrefix,
        },
      );

      const { hints, ids } = selection;
      const debugResponse = isDebug
        ? {
            candidates: ranked.map((result) => ({
              id: result.id,
              baseScore: result.baseScore,
              finalScore: result.finalScore,
              rank: result.rank,
              usageCount: result.feedback.usageCount,
              surfacingCount: result.feedback.surfacingCount,
              lastSurfacedAt: result.feedback.lastSurfacedAt,
              cooledDown: result.cooledDown,
              usageBoost: result.usageBoost,
              unusedPenalty: result.unusedPenalty,
              surfaced: ids.includes(result.id),
            })),
            budget: {
              availableHintBytes: selection.availableHintBytes,
              usedHintBytes: selection.usedHintBytes,
              emittedCount: hints.length,
              dedupedCount: selection.dedupedCount,
              droppedForBudget: selection.droppedForBudget,
            },
          }
        : undefined;

      // Log surfacing events (best-effort, never throws)
      try {
        if (logSurfacing) {
          recallStore.logSurfacing(ids, session_id ?? null);
        }
      } catch { /* non-fatal */ }

      sendJson(res, 200, debugResponse ? { hints, ids, debug: debugResponse } : { hints, ids });
    } catch {
      sendJson(res, 200, { hints: [] });
    } finally {
      if (openedDbPath) closeLcmConnection(openedDbPath);
    }
  };
}
