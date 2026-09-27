import type { SummarizeJobStore } from "../summarize-jobs.js";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection, openStandaloneLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { updateProjectMeta } from "../project-meta.js";
import { projectId, projectDbPath, projectDir } from "../project.js";
import { noopDaemonLog, type DaemonLog } from "../log.js";
import { openProject } from "../project-group.js";
import { enqueue, hasQueuedProjectWork, withProjectMutation } from "../project-queue.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { markSessionCompacted } from "../../db/session-compactions.js";
import { SessionCapture, type TranscriptCaptureResult } from "../../capture.js";
import { EventsDb } from "../../hooks/events-db.js";
import { withHookWrite } from "../../hooks/write-admission.js";
import { eventsDbPath } from "../../db/events-path.js";
import { CompactionEngine, compactEngineConfig, COMPACT_TOKEN_BUDGET } from "../../compaction.js";
import { TranscriptSourceError } from "../../transcript-source.js";
import type { LcmSummarizeFn } from "../../llm/types.js";
import { acceptSummaryText } from "../../llm/summary-rejection.js";
import { ScrubEngine } from "../../scrub.js";
import {
  resolveEffectiveProvider,
  resolveSummarizerLanguage,
  configuredSummaryModel,
  createSummarizer,
  type EffectiveProvider,
} from "../summarizer.js";
import { validateCwd } from "../validate-cwd.js";
import { scheduleProjectLanguageDetection } from "../project-language.js";

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
  /**
   * Absent when no call reported a price. `callsWithCost` says how much of
   * `calls` the figure covers, so a partial total cannot pass for a complete
   * one — and an absent cost never reads as free.
   */
  costUsd?: number;
  callsWithCost: number;
  callsEstimated?: number;
};

function createCompactLlmUsage(provider: string, model: string): CompactLlmUsage {
  return {
    provider, model,
    calls: 0, okCalls: 0, failedCalls: 0,
    tokensSpent: 0, tokensInput: 0, tokensCached: 0, tokensOutput: 0,
    callsWithCost: 0,
  };
}

function addTokens(
  usage: CompactLlmUsage,
  call: { tokens: number; input: number; cached: number; output: number; cost?: number },
): void {
  usage.tokensSpent += call.tokens;
  usage.tokensInput += call.input;
  usage.tokensCached += call.cached;
  usage.tokensOutput += call.output;
  // Only a reported price advances the counters; an unpriced call leaves the
  // total exactly as it was, still absent if nothing has priced anything yet.
  if (call.cost !== undefined) {
    usage.costUsd = (usage.costUsd ?? 0) + call.cost;
    usage.callsWithCost += 1;
  }
}

export function recordCompactLlmUsage(db: DatabaseSync, usage: CompactLlmUsage): void {
  if (usage.calls === 0) return;
  db.prepare(`
    INSERT INTO llm_usage_stats (
      provider, model, calls_total, calls_ok, calls_failed,
      tokens_spent_total, tokens_input_total, tokens_cached_total, tokens_output_total,
      cost_usd_total, calls_with_cost, calls_estimated, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider, model) DO UPDATE SET
      calls_total = calls_total + excluded.calls_total,
      calls_ok = calls_ok + excluded.calls_ok,
      calls_failed = calls_failed + excluded.calls_failed,
      tokens_spent_total = tokens_spent_total + excluded.tokens_spent_total,
      tokens_input_total = tokens_input_total + excluded.tokens_input_total,
      tokens_cached_total = tokens_cached_total + excluded.tokens_cached_total,
      tokens_output_total = tokens_output_total + excluded.tokens_output_total,
      -- An unpriced batch must not reset a total an earlier priced batch built.
      cost_usd_total = CASE
        WHEN excluded.cost_usd_total IS NULL THEN cost_usd_total
        ELSE COALESCE(cost_usd_total, 0) + excluded.cost_usd_total
      END,
      calls_with_cost = calls_with_cost + excluded.calls_with_cost,
      calls_estimated = calls_estimated + excluded.calls_estimated,
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
    // node:sqlite refuses to bind undefined; absent must reach SQL as NULL.
    usage.costUsd ?? null,
    usage.callsWithCost,
    usage.callsEstimated ?? 0,
  );
}

async function captureTranscriptForCompact(
  capture: SessionCapture,
  input: { sessionId: string; cwd: string; client?: string; transcriptPath?: string },
  paths: LcmPaths,
  log: DaemonLog,
): Promise<TranscriptCaptureResult | undefined> {
  const captured = await capture.captureTranscript(input);
  if (captured) {
    const sidecarPath = eventsDbPath(input.cwd, paths);
    if (existsSync(sidecarPath)) {
      try {
        const events = new EventsDb(sidecarPath);
        try {
          captured.backfillModels(events);
        } finally {
          events.close();
        }
      } catch (err) {
        log.write("warn", "compact.model_backfill_failed", { cwd: input.cwd, session_id: input.sessionId, err });
      }
    }
  }
  return captured;
}

type PrecompactStage = {
  status: "completed" | "skipped" | "deferred" | "failed";
  reason?: string;
};

function recordPrecompactStages(
  input: { cwd: string; sessionId: string; client?: string; operationId?: string; capture?: PrecompactStage; summary: PrecompactStage },
  paths: LcmPaths,
  log: DaemonLog,
): void {
  const harness = input.client === "codex" ? "codex" : input.client === "omp" ? "omp" : "claude-command";
  const hook = harness === "omp" ? "session_before_compact" : "PreCompact";
  try {
    withHookWrite(paths, () => {
      const db = new EventsDb(eventsDbPath(input.cwd, paths));
      try {
        if (input.capture) db.recordHookObservation({
          sessionId: input.sessionId, harness, hook, operation: "capture", kind: "execution",
          status: input.capture.status, reason: input.capture.reason,
          ...(input.operationId ? { operationId: `${input.operationId}:capture` } : {}),
          ...(input.capture.status === "failed" ? { failureCode: input.capture.reason ?? "capture-error" } : {}),
        });
        db.recordHookObservation({
          sessionId: input.sessionId, harness, hook, operation: "summary", kind: "execution",
          status: input.summary.status, reason: input.summary.reason,
          ...(input.operationId ? { operationId: `${input.operationId}:summary` } : {}),
          ...(input.summary.status === "failed" ? { failureCode: input.summary.reason ?? "summary-error" } : {}),
        });
      } finally {
        db.close();
      }
    }, undefined);
  } catch (err) {
    log.write("warn", "precompact.observation_failed", { cwd: input.cwd, session_id: input.sessionId, err });
  }
}


export function createCompactHandler(config: DaemonConfig, paths: LcmPaths, jobs?: SummarizeJobStore, log: DaemonLog = noopDaemonLog): RouteHandler {
  const summarizerCache = new Map<EffectiveProvider, Promise<LcmSummarizeFn | null>>();

  const getSummarizer = (provider: EffectiveProvider): Promise<LcmSummarizeFn | null> => {
    let cached = summarizerCache.get(provider);
    if (!cached) {
      cached = createSummarizer(provider, config, jobs);
      summarizerCache.set(provider, cached);
    }
    return cached;
  };

  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id, transcript_path, skip_ingest, client, previous_summary } = input;
    const captureRequired = input.capture_required === true;
    const precompactVerified = input.precompact_verified === true && client === "omp" && skip_ingest === true;
    const operationId = typeof input.operation_id === "string" && input.operation_id.length <= 140
      ? input.operation_id : undefined;
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

    if (captureRequired && skip_ingest) {
      sendJson(res, 400, { error: "capture_required and skip_ingest cannot be combined" });
      return;
    }

    const captureOnly = async () => {
      try {
        // A summary for this session may own the project's queue while waiting on
        // an LLM. Capture must finish before the host's PreCompact deadline.
        const dbPath = projectDbPath(cwd, paths);
        openProject(cwd, paths);
        const scrubber = await ScrubEngine.forProject(
          config.security?.sensitivePatterns ?? [], projectDir(cwd, paths),
        );
        return await withProjectMutation(projectId(cwd), async () => {
          const db = openStandaloneLcmConnection(dbPath);
          try {
            runLcmMigrations(db);
            const captured = await captureTranscriptForCompact(new SessionCapture(db, projectId(cwd), scrubber), {
              sessionId: session_id, cwd, client, transcriptPath: transcript_path,
            }, paths, log);
            const outcome = captured
              ? { status: "completed" as const, messages: captured.records.length }
              : { status: "deferred" as const, reason: "no-capture-result" as const };
            log.write("info", "precompact.capture", { cwd, session_id, ...outcome });
            return outcome;
          } finally {
            db.close();
          }
        });
      } catch (err) {
        log.write("error", "precompact.capture_failed", { cwd, session_id, err });
        return { status: "failed" as const, reason: err instanceof TranscriptSourceError ? "invalid-source" as const : "capture-error" as const };
      }
    };

    const skipBusy = async () => {
      log.write("info", "compact.skipped", { cwd, session_id, reason: "project-busy" });
      const captureOutcome = captureRequired ? await captureOnly() : undefined;
      if (captureRequired) log.write("info", "precompact.summary", { cwd, session_id, status: "skipped", reason: "busy" });
      if (captureRequired && captureOutcome) recordPrecompactStages({
        cwd, sessionId: session_id, client, operationId, capture: captureOutcome,
        summary: { status: "skipped", reason: "busy" },
      }, paths, log);
      if (precompactVerified) recordPrecompactStages({
        cwd, sessionId: session_id, client, operationId,
        summary: { status: "skipped", reason: "busy" },
      }, paths, log);
      sendJson(res, 200, {
        skipped: true,
        replayOutcome: "skipped",
        summary: captureRequired || precompactVerified ? "" : "Compaction already in progress for this session.",
        ...(captureRequired ? { captureOutcome, summaryOutcome: { status: "skipped", reason: "busy" } } : {}),
      });
    };

    // Guard must be checked and set synchronously (before any await) to prevent
    // concurrent requests from racing through the has() check before add() runs.
    if (compactingNow.has(session_id) || ((captureRequired || precompactVerified) && hasQueuedProjectWork(projectId(cwd)))) {
      await skipBusy();
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
      "session": "Live session",
    };
    const providerLabel = providerLabels[effectiveProvider] ?? effectiveProvider;

    let captureOutcomeForError: { status: "completed"; messages: number } | { status: "failed"; reason: string } | undefined;
    try {
      const summarize = captureRequired ? null : await getSummarizer(effectiveProvider);
      if (!summarize && !captureRequired) {
        log.write("info", "compact.skipped", { cwd, session_id, reason: "disabled" });
        if (precompactVerified) recordPrecompactStages({
          cwd, sessionId: session_id, client, operationId,
          summary: { status: "skipped", reason: "disabled" },
        }, paths, log);
        sendJson(res, 200, {
          summary: "Summarization disabled — no summarizer configured.",
          replayOutcome: "disabled",
          providerId: effectiveProvider,
          providerLabel,
        });
        return;
      }
      const pid = projectId(cwd);
      // Summarizer setup awaited above, so another request may have entered the
      // queue since the first admission check. Recheck without awaiting before enqueue.
      if (precompactVerified && hasQueuedProjectWork(pid)) {
        await skipBusy();
        return;
      }
      const result = await enqueue(pid, async () => {
        const dbPath = projectDbPath(cwd, paths);
        openProject(cwd, paths);
        const llmUsage = createCompactLlmUsage(effectiveProvider, config.llm.model);
        const usageByProvider = new Map<string, CompactLlmUsage>();
        const answeringProviders = new Set<string>();

        const scrubber = await ScrubEngine.forProject(
          config.security?.sensitivePatterns ?? [],
          projectDir(cwd, paths),
        );

        return withProjectMutation(pid, async (lease) => {
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          // Capture what the transcript holds past the stored count, through the same
          // module `/ingest` reads and writes with; the conversation exists after this
          // either way, since compaction needs the row even when nothing was read.
          const capture = new SessionCapture(db, pid, scrubber);
          const { conversationStore, summaryStore } = capture;
          let captured: TranscriptCaptureResult | undefined;
          if (!skip_ingest) {
            try {
              captured = await captureTranscriptForCompact(capture, {
                sessionId: session_id, client, cwd, transcriptPath: transcript_path,
              }, paths, log);
            } catch (err) {
              if (captureRequired) captureOutcomeForError = {
                status: "failed",
                reason: err instanceof TranscriptSourceError ? "invalid-source" : "capture-error",
              };
              throw err;
            }
          }
          const captureOutcome = captureRequired
            ? captured
              ? { status: "completed" as const, messages: captured.records.length }
              : { status: "deferred" as const, reason: "no-capture-result" as const }
            : undefined;
          if (captureRequired) {
            log.write("info", "precompact.capture", { cwd, session_id, ...captureOutcome });
            if (captured) captureOutcomeForError = captureOutcome as { status: "completed"; messages: number };
            else return {
              summary: "",
              replayOutcome: "skipped",
              providerId: effectiveProvider,
              providerLabel,
              captureOutcome,
              summaryOutcome: { status: "skipped" as const, reason: "capture-deferred" },
            };
          }
          const conversation = captured ?? await capture.write({ sessionId: session_id, messages: [] });

          // Check if there's anything to compact
          const tokenCount = await summaryStore.getContextTokenCount(conversation.conversationId);

          if (tokenCount === 0) {
            // A replay ledgers this as done; otherwise every later run sees a gap here.
            return {
              summary: "No messages to compact.", replayOutcome: "no_work", providerId: effectiveProvider, providerLabel,
              ...(captureRequired ? { captureOutcome, summaryOutcome: { status: "skipped", reason: "no-work" } } : {}),
            };
          }

          const activeSummarize = captureRequired ? await getSummarizer(effectiveProvider) : summarize;
          if (!activeSummarize) {
            return {
              summary: "Summarization disabled — no summarizer configured.",
              replayOutcome: "disabled",
              providerId: effectiveProvider,
              providerLabel,
              captureOutcome,
              summaryOutcome: { status: "skipped" as const, reason: "disabled" },
            };
          }

          let language = resolveSummarizerLanguage(config, cwd, paths);
          if (language === undefined) {
            const detection = scheduleProjectLanguageDetection(cwd, db, config, paths, client);
            await lease.yieldWhile(() => detection);
            language = resolveSummarizerLanguage(config, cwd, paths);
          } else {
            void scheduleProjectLanguageDetection(cwd, db, config, paths, client);
          }

          let sawReportedUsageModel = false;
          // Each answer the summarizer gave and the engine kept, in order; the engine drops
          // the latest when it discards it (see onAnswerDiscarded below).
          const keptAnswers: Array<{ providers: string[]; model?: string }> = [];
          /** A failed attempt whose response reported no usage: one failed call, no tokens. */
          const countUnmeteredFailure = ({ provider, model }: { provider: string; model?: string }) => {
            const key = JSON.stringify([provider, model ?? config.llm.model]);
            const bucket = usageByProvider.get(key) ?? createCompactLlmUsage(provider, model ?? config.llm.model);
            bucket.calls += 1;
            bucket.failedCalls += 1;
            usageByProvider.set(key, bucket);
            llmUsage.calls += 1;
            llmUsage.failedCalls += 1;
          };
          const summarizeWithUsage: LcmSummarizeFn = async (text, aggressive, ctx = {}) => {
            // One attempt is what one provider answered: the session's answer and the
            // fallback that replaced it are two attempts, each settled with its own outcome.
            let callTokensSpent: { tokens: number; input: number; cached: number; output: number; cost?: number } =
              { tokens: 0, input: 0, cached: 0, output: 0 };
            let sawUsage = false;
            let attemptModel: string | undefined;
            const callUsage = new Map<string, CompactLlmUsage>();
            // Only an attempt whose answer is stored names the provider that answered.
            const attemptAnswering = new Set<string>();
            // The chain link running now, as the chain announced it: it names and counts an
            // attempt whose response carried no usage at all.
            let attempt: { provider: string; kind: string; model?: string } | undefined;
            const settleAttempt = (ok: boolean) => {
              // A session miss spent nothing lcm can see and is logged as a fallback; an HTTP
              // or process attempt with no usage still ran, and is named or counted.
              if (attempt && !sawUsage && attempt.kind !== "session") {
                if (ok) attemptAnswering.add(attempt.provider);
                else countUnmeteredFailure(attempt);
              }
              if (ok) keptAnswers.push({ providers: [...attemptAnswering], model: attemptModel ?? attempt?.model });
              attempt = undefined;
              attemptModel = undefined;
              if (sawUsage) {
                llmUsage.calls += 1;
                llmUsage.okCalls += ok ? 1 : 0;
                llmUsage.failedCalls += ok ? 0 : 1;
                addTokens(llmUsage, callTokensSpent);
              }
              for (const call of callUsage.values()) {
                const key = JSON.stringify([call.provider, call.model]);
                const bucket = usageByProvider.get(key) ?? createCompactLlmUsage(call.provider, call.model);
                const failedAttempt = call.failedCalls > 0;
                const answeredAttempt = call.okCalls > 0;
                bucket.calls += failedAttempt ? call.failedCalls : answeredAttempt ? call.okCalls : 1;
                bucket.okCalls += answeredAttempt ? call.okCalls : failedAttempt ? 0 : ok ? 1 : 0;
                bucket.failedCalls += failedAttempt ? call.failedCalls : answeredAttempt ? 0 : ok ? 0 : 1;
                bucket.callsEstimated = (bucket.callsEstimated ?? 0) + (call.callsEstimated ?? 0);
                addTokens(bucket, { tokens: call.tokensSpent, input: call.tokensInput,
                  cached: call.tokensCached, output: call.tokensOutput, cost: call.costUsd });
                usageByProvider.set(key, bucket);
              }
              attemptAnswering.clear();
              callUsage.clear();
              callTokensSpent = { tokens: 0, input: 0, cached: 0, output: 0 };
              sawUsage = false;
            };
            try {
              const answer = await lease.yieldWhile(() => activeSummarize(text, aggressive, {
                ...ctx,
                sessionId: session_id,
                client,
                onAttempt: (next) => { attempt = next; },
                onFallback: ({ reason, fromProvider, toProvider }) => {
                  settleAttempt(false); // the abandoned attempt was charged but answered nothing usable
                  // The next attempt is the fallback's, even when it reports no usage.
                  attemptAnswering.add(toProvider);
                  log.write("warn", "summarizer.fallback", { cwd, session_id, reason, from_provider: fromProvider, to_provider: toProvider });
                },
                onUsage: (usage) => {
                  // Every provider reports normalized usage; only providers
                  // whose response carries it call onUsage at all.
                  sawUsage = true;
                  const key = JSON.stringify([usage.provider, usage.model ?? config.llm.model, usage.failed ?? "derived"]);
                  let bucket = callUsage.get(key);
                  if (!bucket) {
                    bucket = createCompactLlmUsage(usage.provider, usage.model ?? config.llm.model);
                    callUsage.set(key, bucket);
                  }
                  if (usage.failed === true) bucket.failedCalls += 1;
                  else if (usage.failed === false) bucket.okCalls += 1;
                  else attemptAnswering.add(usage.provider);
                  // One per estimated response, not a flag: a call that retries reports
                  // usage more than once and each estimated response counts.
                  bucket.callsEstimated = (bucket.callsEstimated ?? 0) + (usage.estimated ? 1 : 0);
                  addTokens(bucket, { tokens: usage.tokensUsed, input: usage.inputTokens ?? 0,
                    cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens ?? 0, cost: usage.costUsd });

                  callTokensSpent.tokens += usage.tokensUsed;
                  callTokensSpent.input += usage.inputTokens ?? 0;
                  callTokensSpent.cached += usage.cachedInputTokens ?? 0;
                  callTokensSpent.output += usage.outputTokens ?? 0;
                  if (typeof usage.costUsd === "number") {
                    callTokensSpent.cost = (callTokensSpent.cost ?? 0) + usage.costUsd;
                  }
                  const reportedModel = usage.model?.trim();
                  // The attempt's answering model is settled with the attempt; until an answer is
                  // stored, the first model reported names the run.
                  if (reportedModel && usage.failed === undefined) attemptModel ??= reportedModel;
                  if (reportedModel && !sawReportedUsageModel) {
                    llmUsage.model = reportedModel;
                    sawReportedUsageModel = true;
                  }
                  ctx.onUsage?.(usage);
                },
              }));
              // The engine gates every answer too; judging it here as well keeps an answer
              // the engine will reject from being counted as a successful call.
              const summary = acceptSummaryText(answer, effectiveProvider);
              settleAttempt(true);
              return summary;
            } catch (error) {
              settleAttempt(false);
              throw error;
            }
          };

          const engine = new CompactionEngine(
            conversationStore,
            summaryStore,
            { ...compactEngineConfig({ scrubber, language }), onAnswerDiscarded: () => { keptAnswers.pop(); } },
          );

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

          try {
            updateProjectMeta(cwd, paths, { lastCompact: new Date().toISOString() });
          } catch (err) {
            log.write("warn", "compact.meta_failed", { cwd, session_id, err });
          }

          // Tell the restore that follows to replay the saved instructions.
          markSessionCompacted(db, session_id);

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

          // Name the provider that actually answered when it was a single one: with the
          // session provider the fallback may have done the work, and the PreCompact banner
          // should say so. Several providers in one run keep the configured name.
          for (const kept of keptAnswers) for (const provider of kept.providers) answeringProviders.add(provider);
          // The stored answer names the model. One that reported none (an unmetered
          // fallback), or none kept at all (the engine stored its truncation), gets the
          // configured model — never a discarded or rejected attempt's.
          llmUsage.model = keptAnswers.at(-1)?.model ?? configuredSummaryModel(config, effectiveProvider) ?? config.llm.model;
          const answeredBy = [...answeringProviders];
          const answeredProvider = answeredBy.length === 1 ? answeredBy[0] : effectiveProvider;
          const sessionLabels: Record<string, string> = { "session:haiku": "Live session (haiku)", "session:fork": "Live session (fork)" };
          const answeredLabel = answeredProvider === effectiveProvider
            ? providerLabel
            : (sessionLabels[answeredProvider] ?? providerLabels[answeredProvider as EffectiveProvider] ?? answeredProvider);
          if (llmUsage.calls > 0) llmUsage.provider = answeredProvider;

          return {
            summary: summaryMsg,
            latestSummaryContent,
            latestSummaryId,
            latestSummaryIds,
            replayOutcome: compactResult.actionTaken ? "compacted" : "no_work",
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter,
            providerId: answeredProvider,
            providerLabel: answeredLabel,
            ...(captureRequired ? {
              captureOutcome,
              summaryOutcome: { status: compactResult.actionTaken ? "completed" : "skipped", reason: compactResult.actionTaken ? undefined : "no-work" },
            } : {}),
            ...(llmUsage.calls > 0 ? { llmUsage } : {}),
          };
        } catch (error) {
          if (error instanceof Error && llmUsage.calls > 0) {
            (error as Error & { llmUsage?: CompactLlmUsage }).llmUsage = llmUsage;
          }
          throw error;
        } finally {
          try {
            for (const usage of usageByProvider.values()) recordCompactLlmUsage(db, usage);
          } catch (err) {
            log.write("warn", "compact.usage_failed", { cwd, session_id, err }); // stats accounting only
          }
          closeLcmConnection(dbPath);
        }
        });
      }); // end enqueue

      if (result.replayOutcome === "compacted" && "tokensBefore" in result) {
        log.write("info", "compact.done", { cwd, session_id, tokens_before: result.tokensBefore, tokens_after: result.tokensAfter });
      } else {
        log.write("info", "compact.skipped", { cwd, session_id, reason: result.replayOutcome });
      }
      if (captureRequired && "summaryOutcome" in result) {
        const outcome = result.summaryOutcome;
        log.write("info", "precompact.summary", { cwd, session_id, ...outcome });
        if ("captureOutcome" in result && result.captureOutcome) recordPrecompactStages({
          cwd, sessionId: session_id, client, operationId,
          capture: result.captureOutcome as PrecompactStage,
          summary: outcome as PrecompactStage,
        }, paths, log);
      }
      if (precompactVerified) recordPrecompactStages({
        cwd, sessionId: session_id, client, operationId,
        summary: result.replayOutcome === "compacted"
          ? { status: "completed" }
          : { status: "skipped", reason: result.replayOutcome },
      }, paths, log);
      sendJson(res, 200, result);
    } catch (err) {
      log.write("error", "compact.failed", { cwd, session_id, err });
      if (captureRequired) {
        if (captureOutcomeForError?.status !== "completed") {
          log.write("error", "precompact.capture_failed", { cwd, session_id, err });
        }
        log.write("info", "precompact.summary", {
          cwd, session_id,
          status: captureOutcomeForError?.status === "completed" ? "failed" : "skipped",
          reason: captureOutcomeForError?.status === "completed" ? "summary-error" : "capture-failed",
        });
        recordPrecompactStages({
          cwd, sessionId: session_id, client, operationId,
          capture: captureOutcomeForError ?? { status: "failed", reason: "capture-error" },
          summary: captureOutcomeForError?.status === "completed"
            ? { status: "failed", reason: "summary-error" }
            : { status: "skipped", reason: "capture-failed" },
        }, paths, log);
      }
      if (precompactVerified) recordPrecompactStages({
        cwd, sessionId: session_id, client, operationId,
        summary: { status: "failed", reason: "summary-error" },
      }, paths, log);
      const llmUsage =
        err instanceof Error
          ? (err as Error & { llmUsage?: CompactLlmUsage }).llmUsage
          : undefined;
      sendJson(res, err instanceof TranscriptSourceError ? 400 : 500, {
        error: err instanceof Error ? err.message : "compact failed",
        ...(captureRequired ? {
          captureOutcome: captureOutcomeForError ?? { status: "failed", reason: "capture-error" },
          summaryOutcome: captureOutcomeForError?.status === "completed"
            ? { status: "failed", reason: "summary-error" }
            : { status: "skipped", reason: "capture-failed" },
        } : {}),
        ...(llmUsage ? { llmUsage } : {}),
      });
    } finally {
      releaseCompacting();
    }
  };
}
