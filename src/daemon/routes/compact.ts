import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import { projectId, projectDbPath, projectDir, projectMetaPath, ensureProjectDir, isSafeTranscriptPath } from "../project.js";
import { enqueue } from "../project-queue.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { upsertRedactionCounts } from "../../db/redaction-stats.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { CompactionEngine, compactEngineConfig, COMPACT_TOKEN_BUDGET } from "../../compaction.js";
import { parseTranscript } from "../../transcript.js";
import type { LcmSummarizeFn } from "../../llm/types.js";
import { ScrubEngine } from "../../scrub.js";
import { resolveEffectiveProvider, createSummarizer, type EffectiveProvider } from "../summarizer.js";
import { validateCwd } from "../validate-cwd.js";

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function buildCompactionMessage(p: {
  tokensBefore: number; tokensAfter: number;
  messageCount: number; summaryCount: number;
  maxDepth: number; promotedCount: number;
}): string {
  const saved = p.tokensBefore - p.tokensAfter;
  const ratio = p.tokensAfter > 0 ? (p.tokensBefore / p.tokensAfter).toFixed(1) : "–";
  const pct = p.tokensBefore > 0
    ? ((1 - p.tokensAfter / p.tokensBefore) * 100).toFixed(1)
    : "0.0";
  const barWidth = 30;
  const filled = p.tokensBefore > 0
    ? Math.round((1 - p.tokensAfter / p.tokensBefore) * barWidth) : 0;
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const border = "━".repeat(46);
  const numW = Math.max(
    String(p.messageCount).length,
    String(p.summaryCount).length,
    String(p.maxDepth).length,
    String(p.promotedCount).length,
    1,
  );
  const pad = (n: number) => String(n).padStart(numW);
  const rows = [
    `  ${pad(p.messageCount)}  messages  →  ${p.summaryCount} summaries`,
    `  ${pad(p.maxDepth)}  DAG layers deep`,
    ...(p.promotedCount > 0
      ? [`  ${pad(p.promotedCount)}  insight${p.promotedCount > 1 ? "s" : ""} promoted to long-term memory`]
      : []),
  ];
  return [
    border,
    `  🧠  lossless-claude · compaction complete`,
    border,
    ``,
    `  ${fmtN(p.tokensBefore)} ──────────────────────→ ${fmtN(p.tokensAfter)}`,
    `  ${bar}  ${pct}% saved`,
    `  ${ratio}×  compression  ·  ${fmtN(saved)} tokens freed`,
    ``,
    ...rows,
    ``,
    border,
    `  Nothing was lost. Everything is remembered.`,
    border,
  ].join("\n");
}

// In-memory justCompacted map (session_id -> timestamp)
export const justCompactedMap = new Map<string, number>();
export const JUST_COMPACTED_TTL_MS = 30_000;

// Guard against concurrent compactions for the same session (session_id → cwd)
const compactingNow = new Map<string, string>();

/**
 * Session ids currently being compacted for a project. Lets CLI callers detect
 * an in-flight daemon compaction before a `--restart` wipes the project's
 * summaries; detection only, the check-then-wipe is not atomic.
 */
export function compactingSessionsFor(cwd: string): string[] {
  const id = projectId(cwd);
  return [...compactingNow].filter(([, c]) => projectId(c) === id).map(([sessionId]) => sessionId);
}

/** Register an in-flight compaction; returns the release function. */
export function markCompacting(sessionId: string, cwd: string): () => void {
  compactingNow.set(sessionId, cwd);
  return () => { compactingNow.delete(sessionId); };
}

export type CompactLlmUsage = {
  provider: string;
  model: string;
  calls: number;
  okCalls: number;
  failedCalls: number;
  tokensSpent: number;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
};

function createCompactLlmUsage(provider: string, model: string): CompactLlmUsage {
  return {
    provider, model,
    calls: 0, okCalls: 0, failedCalls: 0,
    tokensSpent: 0, tokensInput: 0, tokensCached: 0, tokensOutput: 0,
  };
}

function addTokens(
  usage: CompactLlmUsage,
  call: { tokens: number; input: number; cached: number; output: number },
): void {
  usage.tokensSpent += call.tokens;
  usage.tokensInput += call.input;
  usage.tokensCached += call.cached;
  usage.tokensOutput += call.output;
}

export function recordCompactLlmUsage(db: DatabaseSync, usage: CompactLlmUsage): void {
  if (usage.calls === 0) return;
  db.prepare(`
    INSERT INTO llm_usage_stats (
      provider, model, calls_total, calls_ok, calls_failed,
      tokens_spent_total, tokens_input_total, tokens_cached_total, tokens_output_total, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider, model) DO UPDATE SET
      calls_total = calls_total + excluded.calls_total,
      calls_ok = calls_ok + excluded.calls_ok,
      calls_failed = calls_failed + excluded.calls_failed,
      tokens_spent_total = tokens_spent_total + excluded.tokens_spent_total,
      tokens_input_total = tokens_input_total + excluded.tokens_input_total,
      tokens_cached_total = tokens_cached_total + excluded.tokens_cached_total,
      tokens_output_total = tokens_output_total + excluded.tokens_output_total,
      updated_at = datetime('now')
  `).run(
    usage.provider,
    usage.model,
    usage.calls,
    usage.okCalls,
    usage.failedCalls,
    usage.tokensSpent,
    usage.tokensInput,
    usage.tokensCached,
    usage.tokensOutput,
  );
}


export function createCompactHandler(config: DaemonConfig): RouteHandler {
  const summarizerCache = new Map<EffectiveProvider, Promise<LcmSummarizeFn | null>>();

  const getSummarizer = (provider: EffectiveProvider): Promise<LcmSummarizeFn | null> => {
    let cached = summarizerCache.get(provider);
    if (!cached) {
      cached = createSummarizer(provider, config);
      summarizerCache.set(provider, cached);
    }
    return cached;
  };

  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id, transcript_path, skip_ingest, client, previous_summary } = input;
    const MAX_PREVIOUS_SUMMARY_LENGTH = 50_000;
    const validatedPreviousSummary = typeof previous_summary === "string"
      ? previous_summary.slice(0, MAX_PREVIOUS_SUMMARY_LENGTH)
      : undefined;

    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd are required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    // Guard must be checked and set synchronously (before any await) to prevent
    // concurrent requests from racing through the has() check before add() runs.
    if (compactingNow.has(session_id)) {
      sendJson(res, 200, {
        skipped: true,
        replayOutcome: "skipped",
        summary: "Compaction already in progress for this session.",
      });
      return;
    }
    const releaseCompacting = markCompacting(session_id, cwd);

    const effectiveProvider = resolveEffectiveProvider(config, client);
    const providerLabels: Record<EffectiveProvider, string> = {
      "claude-process": "Claude (process)",
      "codex-process": "Codex (process)",
      "copilot-process": "Copilot (process)",
      "anthropic": "Anthropic API",
      "openai": "OpenAI API",
      "disabled": "Disabled",
    };
    const providerLabel = providerLabels[effectiveProvider] ?? effectiveProvider;

    try {
      const summarize = await getSummarizer(effectiveProvider);
      if (!summarize) {
        sendJson(res, 200, {
          summary: "Summarization disabled — no summarizer configured.",
          replayOutcome: "disabled",
          providerId: effectiveProvider,
          providerLabel,
        });
        return;
      }
      const pid = projectId(cwd);
      const result = await enqueue(pid, async () => {
        const dbPath = projectDbPath(cwd);
        ensureProjectDir(cwd);
        const llmUsage = createCompactLlmUsage(effectiveProvider, config.llm.model);

        const scrubber = await ScrubEngine.forProject(
          config.security?.sensitivePatterns ?? [],
          projectDir(cwd),
        );

        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          const conversationStore = new ConversationStore(db);
          const summaryStore = new SummaryStore(db);
          const conversation = await conversationStore.getOrCreateConversation(session_id);

          // Ingest new messages from the transcript into the DB.
          const safeTranscriptPath = transcript_path ? isSafeTranscriptPath(transcript_path, cwd) : false;
          if (!skip_ingest && safeTranscriptPath && existsSync(safeTranscriptPath)) {
            const parsed = parseTranscript(safeTranscriptPath);
            const storedCount = await conversationStore.getMessageCount(conversation.conversationId);
            const newMessages = parsed.slice(storedCount);
            if (newMessages.length > 0) {
              const ingestCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
              const inputs = newMessages.map((m, i) => {
                const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project } = scrubber.scrubWithCounts(m.content);
                ingestCounts.gitleaks += gitleaks;
                ingestCounts.builtIn += builtIn;
                ingestCounts.global += globalCount;
                ingestCounts.project += project;
                return {
                  conversationId: conversation.conversationId,
                  seq: storedCount + i,
                  role: m.role as "user" | "assistant" | "system",
                  content: scrubbedContent,
                  tokenCount: m.tokenCount,
                };
              });
              await conversationStore.withTransaction(async () => {
                const records = await conversationStore.createMessagesBulk(inputs);
                upsertRedactionCounts(db, pid, ingestCounts);
                await summaryStore.appendContextMessages(conversation.conversationId, records.map((r) => r.messageId));
              });
            }
          }

          // Check if there's anything to compact
          const tokenCount = await summaryStore.getContextTokenCount(conversation.conversationId);

          if (tokenCount === 0) {
            // A replay ledgers this as done; otherwise every later run sees a gap here.
            return { summary: "No messages to compact.", replayOutcome: "no_work", providerId: effectiveProvider, providerLabel };
          }

          let sawReportedUsageModel = false;
          const summarizeWithUsage: LcmSummarizeFn = async (text, aggressive, ctx = {}) => {
            const callTokensSpent = { tokens: 0, input: 0, cached: 0, output: 0 };
            let sawUsage = false;
            try {
              const summary = await summarize(text, aggressive, {
                ...ctx,
                onUsage: (usage) => {
                  // Every provider reports normalized usage; only providers
                  // whose response carries it call onUsage at all.
                  sawUsage = true;
                  callTokensSpent.tokens += usage.tokensUsed;
                  callTokensSpent.input += usage.inputTokens ?? 0;
                  callTokensSpent.cached += usage.cachedInputTokens ?? 0;
                  callTokensSpent.output += usage.outputTokens ?? 0;
                  const reportedModel = usage.model?.trim();
                  if (!sawReportedUsageModel && reportedModel) {
                    llmUsage.model = reportedModel;
                    sawReportedUsageModel = true;
                  }
                  ctx.onUsage?.(usage);
                },
              });
              if (sawUsage) {
                llmUsage.calls += 1;
                llmUsage.okCalls += 1;
                addTokens(llmUsage, callTokensSpent);
              }
              return summary;
            } catch (error) {
              if (sawUsage) {
                llmUsage.calls += 1;
                llmUsage.failedCalls += 1;
                addTokens(llmUsage, callTokensSpent);
              }
              throw error;
            }
          };

          const engine = new CompactionEngine(conversationStore, summaryStore, compactEngineConfig({
            leafTargetTokens: config.compaction.leafTokens,
            scrubber,
          }));

          const compactResult = await engine.compact({
            conversationId: conversation.conversationId,
            tokenBudget: COMPACT_TOKEN_BUDGET,
            summarize: summarizeWithUsage,
            force: true,
            previousSummaryContent: validatedPreviousSummary,
          });

          // Gather stats for the compaction message (always, regardless of actionTaken)
          const allSummaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
          const finalMsgCount = await conversationStore.getMessageCount(conversation.conversationId);
          const maxDepth = allSummaries.length > 0 ? Math.max(...allSummaries.map((s) => s.depth)) : 0;

          // Promotion is now handled by the standalone /promote route
          const promotedCount = 0;

          // Update meta.json
          try {
            const metaPath = projectMetaPath(cwd);
            let meta: Record<string, unknown> = {};
            if (existsSync(metaPath)) {
              meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            }
            meta.cwd = cwd;
            meta.lastCompact = new Date().toISOString();
            writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          } catch { /* non-fatal */ }

          // Set justCompacted flag
          justCompactedMap.set(session_id, Date.now());

          const summaryMsg = compactResult.actionTaken
            ? buildCompactionMessage({
                tokensBefore: compactResult.tokensBefore,
                tokensAfter: compactResult.tokensAfter,
                messageCount: finalMsgCount,
                summaryCount: allSummaries.length,
                maxDepth,
                promotedCount,
              })
            : "No compaction needed.";

          let latestSummaryContent: string | undefined;
          let latestSummaryId: string | undefined;
          let latestSummaryIds: string[] | undefined;
          if (compactResult.createdSummaryId) {
            const summaryRecord = await summaryStore.getSummary(compactResult.createdSummaryId);
            latestSummaryContent = summaryRecord?.content;
            latestSummaryId = summaryRecord ? compactResult.createdSummaryId : undefined;
            latestSummaryIds = compactResult.createdSummaryIds;
          } else if (allSummaries.length > 0) {
            // Fall back to the most recent existing summary when no new summary was created
            latestSummaryContent = allSummaries[allSummaries.length - 1]?.content;
          }

          return {
            summary: summaryMsg,
            latestSummaryContent,
            latestSummaryId,
            latestSummaryIds,
            replayOutcome: compactResult.actionTaken ? "compacted" : "no_work",
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter,
            providerId: effectiveProvider,
            providerLabel,
            ...(llmUsage.calls > 0 ? { llmUsage } : {}),
          };
        } catch (error) {
          if (error instanceof Error && llmUsage.calls > 0) {
            (error as Error & { llmUsage?: CompactLlmUsage }).llmUsage = llmUsage;
          }
          throw error;
        } finally {
          try {
            recordCompactLlmUsage(db, llmUsage);
          } catch {
            // non-fatal stats accounting
          }
          closeLcmConnection(dbPath);
        }
      }); // end enqueue

      sendJson(res, 200, result);
    } catch (err) {
      const llmUsage =
        err instanceof Error
          ? (err as Error & { llmUsage?: CompactLlmUsage }).llmUsage
          : undefined;
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "compact failed",
        ...(llmUsage ? { llmUsage } : {}),
      });
    } finally {
      releaseCompacting();
    }
  };
}
