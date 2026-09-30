import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openStandaloneLcmConnection } from "../db/connection.js";
import { loadDaemonConfig, type DaemonConfig } from "../daemon/config.js";
import { DaemonClient } from "../daemon/client.js";
import type { SummarizeJobStore, JobAnswer } from "../daemon/summarize-jobs.js";
import { projectDbPath } from "../daemon/project.js";
import { createSummarizer, resolveSummarizerLanguage } from "../daemon/summarizer.js";
import type { LcmPaths } from "../lcm-paths.js";
import { ConversationStore } from "../store/conversation-store.js";
import { compactEngineConfig, COMPACT_TOKEN_BUDGET } from "../compaction.js";
import { buildSyntheticSession, runEval, type CorpusSession, type EvalRunResult } from "./engine.js";
import { comparisonChunks, renderComparison, type ComparisonReport } from "./report.js";

export type ComparisonOptions = {
  cwd: string;
  paths: LcmPaths;
  sessionId: string;
  models: string[];
  runs?: number;
  out?: string;
  planted?: boolean;
};

/** A standalone read-only handle; no migrations, capture, or compaction of project data. */
async function readSession(cwd: string, paths: LcmPaths, sessionId: string): Promise<CorpusSession> {
  const db = openStandaloneLcmConnection(projectDbPath(cwd, paths), { readOnly: true });
  try {
    const store = new ConversationStore(db);
    const conversation = await store.getConversationBySessionId(sessionId);
    if (!conversation) throw new Error(`No stored session named "${sessionId}" in this project`);
    const messages = await store.getMessages(conversation.conversationId);
    if (messages.length === 0) throw new Error(`Stored session "${sessionId}" has no messages`);
    return { label: sessionId, messages: messages.map((message) => ({
      seq: message.seq, role: message.role, content: message.content,
      tokenCount: message.tokenCount, createdAt: message.createdAt.toISOString(),
    })) };
  } finally {
    db.close();
  }
}

function validateCandidates(config: DaemonConfig, names: string[]): void {
  if (names.length === 0) throw new Error("--models must name at least one endpoint in llm.providers");
  if (new Set(names).size !== names.length) throw new Error("--models must not repeat an endpoint name");
  for (const name of names) {
    if (name === "session-pool") continue;
    if (name === "session") throw new Error("session cannot be evaluated; use session-pool with a dedicated worker");
    if (!config.llm.providers || !Object.hasOwn(config.llm.providers, name)) {
      throw new Error(`Unknown summarizer endpoint "${name}"; declare it in llm.providers`);
    }
    const endpoint = config.llm.providers[name];
    if ("missingEnv" in endpoint && endpoint.missingEnv?.length) {
      throw new Error(`Summarizer endpoint "${name}" needs unset variables: ${endpoint.missingEnv.join(", ")}`);
    }
  }
}

/** Candidates and their repeats run serially, with production adapters and no fallback. */
export async function runSummarizerComparison(options: ComparisonOptions): Promise<{ jsonPath: string; htmlPath: string; report: ComparisonReport }> {
  const { cwd, paths, sessionId, models } = options;
  const runs = options.runs ?? 1;
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const config = loadDaemonConfig(paths.configPath);
  validateCandidates(config, models);
  const language = resolveSummarizerLanguage(config, cwd, paths);
  const sessions = [await readSession(cwd, paths, sessionId)];
  if (options.planted !== false) sessions.push(buildSyntheticSession());
  const results: Array<EvalRunResult & { endpoint: string }> = [];
  for (const name of models) {
    const endpoint = name === "session-pool" ? undefined : config.llm.providers![name];
    const candidateConfig: DaemonConfig = {
      ...config,
      llm: { ...config.llm, provider: name, providers: endpoint ? { [name]: endpoint } : undefined, fallback: [], fallbackProvider: "disabled" },
      summarizer: { ...config.summarizer, mock: false },
    };
    const client = new DaemonClient(`http://127.0.0.1:${config.daemon.port}`, paths.tokenPath);
    const jobs = name === "session-pool" ? { enqueue: async (job: Parameters<SummarizeJobStore["enqueue"]>[0]) => {
      let answer: JobAnswer;
      try {
        answer = await client.post<JobAnswer>("/summarize-jobs/pool", job);
      } catch (error) {
        // DaemonClient reports a failed connection as a TypeError; an HTTP error answer is an Error with a status.
        if (!(error instanceof TypeError)) throw error;
        return { error: `lcm daemon is not running on port ${config.daemon.port} (${error.message}); start it with lcm daemon start --detach` };
      }
      if (answer.error === "job timeout") {
        return { ...answer, error: "session-pool job timed out; start a dedicated worker with LCM_SUMMARIZE_WORKER=1 (see docs/summarize-workers.md)" };
      }
      return answer;
    } } : undefined;
    const summarizer = await createSummarizer(name, candidateConfig, jobs);
    if (!summarizer) throw new Error(`Endpoint "${name}" produced no summarizer`);
    for (const session of sessions) {
      for (let run = 1; run <= runs; run++) {
        const result = await runEval({ session,
          summarizer: name === "session-pool" ? (text, aggressive, ctx) =>
            summarizer(text, aggressive, { ...ctx, sessionId: `eval-${session.label}` }) : summarizer,
          model: endpoint?.model ?? (name === "session-pool" ? "worker-selected" : "default"), provider: endpoint?.type ?? "session-pool", language, run });
        results.push({ ...result, endpoint: name });
      }
    }
  }
  const report: ComparisonReport = {
    version: 1, createdAt: new Date().toISOString(), sessionId, language,
    settings: { ...compactEngineConfig({ language }), tokenBudget: COMPACT_TOKEN_BUDGET },
    candidates: models.map((name) => ({ name, type: name === "session-pool" ? "session-pool" : config.llm.providers![name].type,
      model: name === "session-pool" ? "worker-selected" : config.llm.providers![name].model ?? "default" })),
    results, chunks: comparisonChunks(results, models),
    notice: "Contains conversation content already scrubbed at capture. Unsupported details are a deterministic hint, not proof of hallucination. Unknown cost is null, never free.",
  };
  const out = resolve(options.out ?? "summarizer-report");
  mkdirSync(out, { recursive: true });
  const jsonPath = join(out, "report.json");
  const htmlPath = join(out, "report.html");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(htmlPath, renderComparison(report), { mode: 0o600 });
  return { jsonPath, htmlPath, report };
}
