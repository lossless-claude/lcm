import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { type SearchResult } from "../../db/promoted.js";
import { projectRef } from "../project-group.js";
import { logGroupSurfacing, searchPromotedGroup, type GroupPromotedHit } from "../../search/group-promoted.js";
import { type RecallFeedback } from "../../db/recall.js";
import { buildMemoryContext, selectMemoryHintsWithinBudget } from "../../hooks/memory-context.js";
import { recordUserPromptEvents } from "../../hooks/user-prompt.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import { validateCwd } from "../validate-cwd.js";
import { searchNativeHistory } from "../../search/native-history.js";
import { pivotLanguagesFor, pivotQueryHint } from "../../search/pivot-language.js";
import { extractQueryTerms, languageList } from "../../store/fts5-query.js";

const CANDIDATE_LIMIT_MULTIPLIER = 5;
const MIN_CANDIDATE_LIMIT = 10;

type RankedPromptSearchResult = GroupPromotedHit & {
  baseScore: number;
  finalScore: number;
  usageBoost: number;
  unusedPenalty: number;
  stalePenalty: number;
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
  results: GroupPromotedHit[],
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
    staleAfterDays: number;
    staleSurfacingWithoutUseLimit: number;
    stalePenalty: number;
    allowStaleOnStrongMatch: boolean;
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

      // Staleness: old memory surfaced without use
      const createdAtMs = new Date(result.createdAt).getTime();
      const ageDays = Number.isFinite(createdAtMs) ? (options.now - createdAtMs) / 86_400_000 : 0;
      const isStale = ageDays >= options.staleAfterDays
        && feedback.usageCount === 0
        && feedback.surfacingCount >= options.staleSurfacingWithoutUseLimit;
      const stalePenalty = isStale ? Math.max(0, options.stalePenalty) : 0;

      const rawScore = baseScore * usageBoost - unusedPenalty - stalePenalty;
      // If allowStaleOnStrongMatch, stale memories can still surface if score is high enough
      const finalScore = isStale && !options.allowStaleOnStrongMatch
        ? Math.min(rawScore, 0)
        : rawScore;

      return {
        ...result,
        baseScore,
        finalScore,
        usageBoost,
        unusedPenalty,
        stalePenalty,
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
  /** Also extract passive-learning events from the prompt (the function-hooks module cannot write SQLite). */
  recordEvents?: boolean;
  /** `"context"`: add the rendered `<memory-context>` block to the response as `context`. */
  format?: "context";
  /** Also fill the hint budget from the session's native episodic history (a client whose live capture is searchable before promotion asks for this). */
  nativeHistory?: boolean;
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
    recordEvents: obj.recordEvents === true,
    format: obj.format === "context" ? "context" : undefined,
    nativeHistory: obj.nativeHistory === true,
  };
}

export function createPromptSearchHandler(config: DaemonConfig, paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    let input: PromptSearchRequest;
    try {
      input = validatePromptSearchInput(JSON.parse(body || "{}"));
    } catch {
      // Invalid request — return empty hints (not 400) so callers treat this as "no suggestions"
      sendJson(res, 200, { hints: [] });
      return;
    }

    const { query, session_id, cwd, learningInstructionBytes, logSurfacing, debug: isDebug, recordEvents, format } = input;

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

    // Before any early return: the prompt's events are worth recording even when this
    // project has no memory to search yet.
    if (recordEvents && session_id) {
      try {
        await recordUserPromptEvents(query, session_id, validatedCwd, paths);
      } catch (err) {
        safeLogError("UserPromptSubmit", err, { cwd: validatedCwd, sessionId: session_id, paths });
      }
    }

    const dbPath = projectDbPath(validatedCwd, paths);
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
      const staleAfterDays = config.restoration.staleAfterDays;
      const staleSurfacingWithoutUseLimit = config.restoration.staleSurfacingWithoutUseLimit;
      const stalePenalty = config.restoration.stalePenalty;
      const allowStaleOnStrongMatch = config.restoration.allowStaleOnStrongMatch;

      const targetHintCount = Math.max(maxResults, maxInjectedMemoryItems);
      const candidateLimit = Math.max(targetHintCount * CANDIDATE_LIMIT_MULTIPLIER, MIN_CANDIDATE_LIMIT);
      const languages = pivotLanguagesFor(validatedCwd, config.search.pivotLanguage, paths);
      const queryTerms = extractQueryTerms(query, paths, languageList(languages.authorLanguage));
      // Promoted memory is unioned across every checkout of this repository,
      // and each hit's recall feedback is read from the database that holds it.
      const { hits: results, feedback: feedbackById } = searchPromotedGroup(validatedCwd, {
        query,
        limit: candidateLimit,
        terms: queryTerms,
        withFeedback: true,
      }, paths);

      const now = Date.now();
      const ranked = rankResults(results, feedbackById, {
          querySessionId: session_id,
          now,
          halfLife,
          crossSessionAffinity,
          recallUsageBoost,
          recallUsageSmoothing,
          surfacingCooldownWindow,
          unusedSurfacingPenalty,
          staleAfterDays,
          staleSurfacingWithoutUseLimit,
          stalePenalty,
          allowStaleOnStrongMatch,
        });
      const filtered = applyCooldown(
        ranked,
        minScore,
        resurfaceMargin,
      );

      // A client whose live capture is searchable before promotion or summarization
      // asks for this. Keep promoted ranking intact, and fill the same bounded hint
      // budget with native episodic matches rather than requiring a manual import.
      const history = input.nativeHistory
        ? await searchNativeHistory(db, { query, limit: targetHintCount, terms: queryTerms, project: projectRef(cwd) })
        : [];
      // A hit surfaced from a sibling checkout carries its own project id, so the
      // agent can pass it back to lcm_describe/lcm_expand; a hit from this project
      // renders bare, exactly as before.
      const candidates = filtered.map((result) => ({
        id: result.id,
        projectId: result.project.cwd === validatedCwd ? undefined : result.project.id,
        hint: result.content.length > snippetLength
          ? result.content.slice(0, snippetLength) + "..."
          : result.content,
      }));
      candidates.push(...history.map(hit => ({
        id: "messageId" in hit ? `message:${hit.messageId}` : hit.summaryId,
        // Native history is always searched against the current project (see above).
        projectId: undefined,
        hint: hit.snippet.length > snippetLength ? hit.snippet.slice(0, snippetLength) + "..." : hit.snippet,
      })));

      // Pass the full filtered list (not sliced to maxResults) so the budget
      // selector can choose the best-fitting subset after dedup and truncation.
      // The hint shares the block's byte budget with the hints, so it is
      // reserved before selection rather than appended past the cap.
      const pivotHint = pivotQueryHint(languages);
      const pivotHintBytes = pivotHint ? Buffer.byteLength(pivotHint, "utf8") + 1 : 0;

      const selection = selectMemoryHintsWithinBudget(
        candidates,
        {
          totalByteBudget: Math.max(0, maxInjectedMemoryBytes - pivotHintBytes),
          reservedForLearningInstruction,
          learningInstructionBytes: learningInstructionBytes ?? 0,
          maxEmitted: maxInjectedMemoryItems,
          dedupMinPrefix,
        },
      );

      const { hints, ids, projectIds } = selection;
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
              stalePenalty: result.stalePenalty,
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
        if (logSurfacing) logGroupSurfacing(results, ids, session_id ?? null, paths);
      } catch { /* non-fatal */ }

      const context = format === "context" ? buildMemoryContext(hints, ids, projectIds, pivotHint) : null;
      sendJson(res, 200, {
        hints,
        ids,
        projectIds,
        ...(pivotHint ? { pivotHint } : {}),
        ...(context ? { context } : {}),
        ...(debugResponse ? { debug: debugResponse } : {}),
      });
    } catch {
      sendJson(res, 200, { hints: [] });
    } finally {
      if (openedDbPath) closeLcmConnection(openedDbPath);
    }
  };
}
