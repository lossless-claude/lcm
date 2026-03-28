import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
import { CompactionEngine } from "../../compaction.js";
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

// Guard against concurrent compactions for the same session
const compactingNow = new Set<string>();


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
      sendJson(res, 200, { skipped: true, summary: "Compaction already in progress for this session." });
      return;
    }
    compactingNow.add(session_id);

    const effectiveProvider = resolveEffectiveProvider(config, client);
    const providerLabels: Record<EffectiveProvider, string> = {
      "claude-process": "Claude (process)",
      "codex-process": "Codex (process)",
      "anthropic": "Anthropic API",
      "openai": "OpenAI API",
      "disabled": "Disabled",
    };
    const providerLabel = providerLabels[effectiveProvider] ?? effectiveProvider;

    try {
      const summarize = await getSummarizer(effectiveProvider);
      if (!summarize) {
        sendJson(res, 200, { summary: "Summarization disabled — no summarizer configured.", providerId: effectiveProvider, providerLabel });
        return;
      }
      const pid = projectId(cwd);
      const result = await enqueue(pid, async () => {
        const dbPath = projectDbPath(cwd);
        ensureProjectDir(cwd);

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
            return { summary: "No messages to compact.", providerId: effectiveProvider, providerLabel };
          }

          const engine = new CompactionEngine(conversationStore, summaryStore, {
            contextThreshold: 0.75,
            freshTailCount: 8,
            leafMinFanout: 3,
            condensedMinFanout: 2,
            condensedMinFanoutHard: 1,
            incrementalMaxDepth: 0,
            leafTargetTokens: config.compaction.leafTokens,
            condensedTargetTokens: 900,
            maxRounds: 10,
            scrubber,
          });

          const compactResult = await engine.compact({
            conversationId: conversation.conversationId,
            tokenBudget: 200_000,
            summarize,
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
          if (compactResult.createdSummaryId) {
            const summaryRecord = await summaryStore.getSummary(compactResult.createdSummaryId);
            latestSummaryContent = summaryRecord?.content;
          } else if (allSummaries.length > 0) {
            // Fall back to the most recent existing summary when no new summary was created
            latestSummaryContent = allSummaries[allSummaries.length - 1]?.content;
          }

          return {
            summary: summaryMsg,
            latestSummaryContent,
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter,
            providerId: effectiveProvider,
            providerLabel,
          };
        } finally {
          closeLcmConnection(dbPath);
        }
      }); // end enqueue

      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "compact failed" });
    } finally {
      compactingNow.delete(session_id);
    }
  };
}
