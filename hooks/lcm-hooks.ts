// hooks/lcm-hooks.ts — lcm's function-hooks module (Claude Code early access).
//
// Loaded only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. It claims the session in a temp-dir
// file at session.start, and while that claim stands the PostToolUse, PostToolUseFailure,
// UserPromptSubmit and Stop command hooks stay silent (functionHooksOwnSession in
// src/hooks/session-claim.ts) and this module does their work through the daemon:
//   tool.call       → POST /tool-event    (the daemon writes the passive-learning rows)
//   prompt.submit   → POST /prompt-search (memory hits ride as hidden context on the prompt)
//   prompt.section  → the learning instruction is appended once to the system prompt's
//                     `memory` section, instead of to every prompt.
//   prompt.context  → POST /restore (the session's memory, as one named context block)
//   turn.complete   → POST /ingest (the daemon reads the transcript delta) and
//                     POST /promote-events, at most once a minute, replacing the Stop hook.
// The module has no Node and no SQLite, so the daemon does every write.
//
// Types: run /plugin-types in a session, then `import type { Register } from "claude-code"`.
// `claude plugin validate` reads this file statically: `$` may only be passed to a function
// declared at the top level, and calls on it must be spelled `$.noun.method(...)`.
import type { Register, EngineInterface } from "claude-code";

/** Same set the PostToolUse matcher in plugin.json names; `mcp__*` is matched by prefix. */
const CAPTURED_TOOLS = new Set([
  "Agent", "AskUserQuestion", "Bash", "EnterPlanMode", "ExitPlanMode",
  "Read", "Edit", "Write", "Glob", "Grep", "TaskCreate", "TaskUpdate", "Skill",
]);
const DEFAULT_PORT = 3737;
/** Fallback when the host command cannot report TMPDIR; matches Node os.tmpdir() on POSIX. */
const DEFAULT_TMP_DIR = "/tmp";
/** Same default as hooks.snapshotIntervalSec for the Stop command hook: one ingest a minute. */
const INGEST_INTERVAL_MS = 60_000;
let lastIngestAt = 0;

// Verbatim copy of src/hooks/learning-instruction.ts (the module cannot import from src/);
// test/hooks/learning-instruction.test.ts fails when the two drift.
const LEARNING_INSTRUCTION = `<learning-instruction>
When you recognize a durable insight, call lcm_store immediately:
- decision: architectural/design choice with trade-offs
- preference: user working style or tool preference
- root-cause: bug cause that took effort to uncover
- pattern: codebase convention not documented elsewhere
- gotcha: non-obvious pitfall or footgun
- solution: non-trivial fix worth remembering
- workflow: multi-step process that works

Tag prefixes: type: | scope: | project: | sprint: | source: | priority: | owner: | signal:
Usage: lcm_store(text: "concise insight with why", tags: ["type:decision", "project:<repo>"])

When you act on a surfaced memory (use it to inform a decision, avoid a known pitfall, or reference it in your work), emit:
lcm_store(text: "Acted on memory <id> — <one-line how>", tags: ["signal:memory_used", "memory_id:<id>"])
</learning-instruction>`;

/** What the module cannot read for itself: everything outside $.fs's project-and-temp reach. */
type HostEnv = { port: number; token: string | null; tmpDir: string };
let hostEnv: Promise<HostEnv> | null = null;
/** Routes the running daemon answered 404 for: an older lcm build. Logged once each, not per call. */
const missingRoutes = new Set<string>();

/** No config file yet, or one being rewritten, both mean the compiled-in port. */
function parsePort(configJson: string): number {
  try {
    const port = JSON.parse(configJson).daemon?.port;
    return typeof port === "number" ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

// The daemon's port and bearer token live under ~/.lossless-claude, and TMPDIR is an
// environment value; neither is reachable through $.fs (project and temp dir only), so
// one host command reads all three once per module load.
function readHostEnv($: EngineInterface): Promise<HostEnv> {
  hostEnv ??= $.process.run(["sh", "-c",
    'cat "$HOME/.lossless-claude/daemon.token" 2>/dev/null; echo; echo "__CONFIG__"; '
    + 'cat "$HOME/.lossless-claude/config.json" 2>/dev/null; echo; echo "__TMPDIR__"; '
    + 'printf %s "${TMPDIR:-/tmp}"',
  ]).then(({ stdout }) => {
    const [tokenPart, afterToken = ""] = stdout.split("__CONFIG__");
    const [configPart, tmpPart = ""] = afterToken.split("__TMPDIR__");
    return {
      port: parsePort(configPart),
      token: tokenPart.trim() || null,
      tmpDir: tmpPart.trim().replace(/\/+$/, "") || DEFAULT_TMP_DIR,
    };
  }, () => ({ port: DEFAULT_PORT, token: null, tmpDir: DEFAULT_TMP_DIR }));
  return hostEnv;
}

/**
 * Tell the command hooks this module is live for this session, so they stay silent
 * instead of doing the same work again. Written before the first prompt and read by
 * functionHooksOwnSession in src/hooks/session-claim.ts, which names the same file from
 * Node's os.tmpdir(). No claim means "not mine", costing a duplicate row rather than a
 * lost one, so nothing here is worth failing session.start over.
 */
async function claimSession($: EngineInterface, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const { tmpDir } = await readHostEnv($);
  const file = `${tmpDir}/lcm-claim-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  await $.fs.writeFile(file, JSON.stringify({ sessionId, ts: Date.now() }));
}

/** Last time this module asked the host to start the daemon; one attempt per cooldown window. */
let lastDaemonStartAt = 0;
const DAEMON_START_COOLDOWN_MS = 60_000;
const DAEMON_START_TIMEOUT_MS = 15_000;
/** POSIX exit code for "command not found": no `lcm` binary on PATH. */
const EXIT_COMMAND_NOT_FOUND = 127;
let warnedNoLcmBinary = false;

/**
 * The daemon exits when idle and the command hooks used to bring it back (ensureDaemon).
 * While this module owns the events, it must do the same, or every tool call and prompt
 * between the idle exit and the next SessionStart is lost. `lcm daemon start --detach`
 * spawns the daemon and waits until /health answers.
 */
async function startDaemon($: EngineInterface): Promise<boolean> {
  const now = Date.now();
  if (now - lastDaemonStartAt < DAEMON_START_COOLDOWN_MS) return false;
  lastDaemonStartAt = now;
  const run = await $.process.run(
    ["sh", "-c", 'command -v lcm >/dev/null 2>&1 || exit 127; exec lcm daemon start --detach'],
    { timeoutMs: DAEMON_START_TIMEOUT_MS },
  ).catch(() => null);
  if (run?.exitCode === 0) return true;
  if (run?.exitCode === EXIT_COMMAND_NOT_FOUND && !warnedNoLcmBinary) {
    warnedNoLcmBinary = true;
    $.ui.log("[lcm] daemon is down and no `lcm` binary is on PATH to start it; events are lost until a command hook restarts it");
  } else if (run && run.exitCode !== EXIT_COMMAND_NOT_FOUND) {
    $.ui.log(`[lcm] daemon start failed (exit ${run.exitCode}): ${run.stderr.trim().split("\n")[0] ?? ""}`);
  }
  return false;
}

type PostOutcome = { body: Record<string, unknown> | null; connectionFailed: boolean };

/** A 404 means an older lcm build is listening. Say so once per route, not per call. */
function logMissingRoute($: EngineInterface, route: string, consequence: string): void {
  if (missingRoutes.has(route)) return;
  missingRoutes.add(route);
  $.ui.log(`[lcm] daemon has no ${route} route (older lcm build); ${consequence}`);
}

async function postOnce($: EngineInterface, route: string, body: unknown): Promise<PostOutcome> {
  try {
    const { port, token } = await readHostEnv($);
    const res = await $.http.fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      // Not "the command hooks still record": they stand down while this module holds the
      // session, so an older daemon means the call is simply lost.
      logMissingRoute($, route, "this call is dropped until the daemon is upgraded");
      return { body: null, connectionFailed: false };
    }
    if (!res.ok) {
      $.ui.log(`[lcm] ${route}: daemon answered ${res.status}`);
      return { body: null, connectionFailed: false };
    }
    return { body: JSON.parse(res.text) as Record<string, unknown>, connectionFailed: false };
  } catch {
    // No listener on the port: the daemon idled out or was never started.
    return { body: null, connectionFailed: true };
  }
}

/**
 * POST `body` to the daemon; resolves to the parsed JSON, or null when the daemon lacks the
 * route or cannot be reached. On a connection failure it starts the daemon and retries once.
 */
async function postDaemon($: EngineInterface, route: string, body: unknown): Promise<Record<string, unknown> | null> {
  const first = await postOnce($, route, body);
  if (!first.connectionFailed) return first.body;
  if (!(await startDaemon($))) return null;
  const second = await postOnce($, route, body);
  if (second.connectionFailed) $.ui.log(`[lcm] ${route}: daemon still unreachable after start`);
  return second.body;
}

type SummaryJob = {
  id: string;
  session_id: string;
  kind: "leaf" | "condensed";
  system: string;
  prompt: string;
  maxTokens: number;
};
type SummaryAnswer = {
  text: string;
  providerId: "session:haiku" | "session:fork";
  usage: { input_tokens: number; output_tokens: number; estimated: boolean };
};
const DEFAULT_SUMMARY_OUTPUT_CAP = 50_000;
/** The engine's own estimate ratio; used only when the host reports no usage. */
const CHARS_PER_TOKEN = 4;
/** The host capped the long poll below the daemon's hold, so poll short and pause between. */
const SHORT_POLL_PAUSE_MS = 2_000;
/** The daemon has no summarizer route; a later respawn may bring it back. */
const MISSING_ROUTE_RETRY_MS = 60_000;
/** The daemon answered but not with a job: back off before asking again. */
const POLL_BACKOFF_MS = 5_000;
let summaryPollerStarted = false;

function summaryDelay($: EngineInterface, ms: number): Promise<void> {
  return new Promise((resolve) => { $.clock.after(ms, resolve); });
}

async function completeSummary($: EngineInterface, job: SummaryJob): Promise<SummaryAnswer> {
  const text = await $.model.complete({
    model: "haiku", system: job.system, prompt: job.prompt, maxTokens: job.maxTokens,
  });
  const trimmed = text.trim();
  return {
    text: trimmed, providerId: "session:haiku",
    usage: {
      input_tokens: Math.ceil((job.system.length + job.prompt.length) / CHARS_PER_TOKEN),
      output_tokens: Math.ceil(trimmed.length / CHARS_PER_TOKEN), estimated: true,
    },
  };
}

async function answerSummary($: EngineInterface, job: SummaryJob): Promise<SummaryAnswer> {
  if (job.kind === "condensed") {
    const fork = await $.model.fork({ prompt: `${job.system}\n\n${job.prompt}` }).catch(() => null);
    if (fork !== null) {
      return {
        text: fork.text.trim(), providerId: "session:fork",
        usage: { input_tokens: fork.usage.input_tokens, output_tokens: fork.usage.output_tokens, estimated: false },
      };
    }
  }
  return completeSummary($, job);
}

/**
 * One poll of `/summarize-jobs/next`. A `job` is one to run; `wait` means the daemon
 * answered something other than a job and the caller should back off for that long.
 */
type PollOutcome =
  | { job: SummaryJob }
  | { wait: number; shortPoll?: true };

function fetchNextJob($: EngineInterface, sessionId: string, shortPoll: boolean) {
  return readHostEnv($).then(({ port, token }) => $.http.fetch(
    `http://127.0.0.1:${port}/summarize-jobs/next?session_id=${encodeURIComponent(sessionId)}${shortPoll ? "&wait_ms=0" : ""}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  ));
}

/** Turns a non-job response into how long to wait before asking again. */
function classifyPollResponse($: EngineInterface, status: number): { wait: number } {
  if (status === 204) return { wait: 0 };
  if (status === 404) {
    // An older build answered, or the daemon was swapped mid-session. A later
    // respawn may bring the route back, so keep checking, slowly.
    logMissingRoute($, "/summarize-jobs/next", "retrying every minute");
    return { wait: MISSING_ROUTE_RETRY_MS };
  }
  if (status === 401) hostEnv = null;
  $.ui.log(`[lcm] /summarize-jobs/next: daemon answered ${status}`);
  return { wait: POLL_BACKOFF_MS };
}

async function nextSummaryJob(
  $: EngineInterface, sessionId: string, shortPoll: boolean,
): Promise<PollOutcome> {
  let job: SummaryJob | undefined;
  try {
    const response = await fetchNextJob($, sessionId, shortPoll);
    if (!response.ok || response.status === 204) return classifyPollResponse($, response.status);
    // The parse stays inside the try: a malformed 200 backs off and respawns the
    // daemon like any other transport failure, instead of stopping the poller.
    job = JSON.parse(response.text).job as SummaryJob;
  } catch {
    // Some hosts cap HTTP request duration below the daemon's 25-second hold.
    await startDaemon($);
    hostEnv = null; // A restarted daemon may have a new bearer token.
    return { wait: POLL_BACKOFF_MS, shortPoll: true };
  }
  // Do not run a prompt belonging to another session, even on a malformed response.
  if (!job || job.session_id !== sessionId) {
    $.ui.log("[lcm] discarded summary job for a different session");
    return { wait: POLL_BACKOFF_MS };
  }
  return { job };
}

type SummaryBudget = { spent: number; cap: number };

/** Answers one job. Returns the output tokens it spent, or null when the cap was hit. */
async function serveSummaryJob(
  $: EngineInterface, job: SummaryJob, { spent, cap }: SummaryBudget,
): Promise<number | null> {
  const route = `/summarize-jobs/${encodeURIComponent(job.id)}`;
  if (spent >= cap) {
    await postDaemon($, route, { error: "spend cap" });
    return null;
  }
  try {
    const answer = await answerSummary($, job);
    if (spent + answer.usage.output_tokens > cap) {
      await postDaemon($, route, { error: "spend cap" });
      return null;
    }
    if (!answer.text) throw new Error("empty summary");
    await postDaemon($, route, answer);
    return answer.usage.output_tokens;
  } catch (error) {
    await postDaemon($, route, { error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

/** One request at a time also serializes jobs from concurrent daemon compactions. */
async function pollSummaries($: EngineInterface, cap: number): Promise<void> {
  const sessionId = await $.session.id();
  let spent = 0;
  let shortPoll = false;
  while (true) {
    if (shortPoll) await summaryDelay($, SHORT_POLL_PAUSE_MS);
    const outcome = await nextSummaryJob($, sessionId, shortPoll);
    if ("wait" in outcome) {
      shortPoll = outcome.shortPoll ?? shortPoll;
      if (outcome.wait > 0) await summaryDelay($, outcome.wait);
      continue;
    }
    const spentNow = await serveSummaryJob($, outcome.job, { spent, cap });
    if (spentNow === null) return;
    spent += spentNow;
  }
}

type On = Parameters<Register>[0];

/** Read the daemon's address and make sure it is listening before the first prompt. */
function registerSessionStart(on: On, summaryCap: number): void {
  on("session.start", async ($, e, next) => {
    // Awaited, unlike the health probe: a command hook that runs before the claim lands
    // would record the same events this module is about to record.
    const sessionId = await $.session.id();
    await claimSession($, sessionId).catch((error: unknown) => {
      $.ui.log(`[lcm] could not claim the session, command hooks stay active: ${String(error)}`);
    });
    void readHostEnv($).then(({ port }) =>
      $.http.fetch(`http://127.0.0.1:${port}/health`).then(() => undefined, () => startDaemon($)));
    // The housekeeping the SessionStart command hook awaited. Nothing reads its result,
    // and the session has no reason to wait for a prune.
    void $.session.cwd().then((cwd) => postDaemon($, "/session-scavenge", { cwd }));
    if (summaryCap > 0 && !summaryPollerStarted) {
      summaryPollerStarted = true;
      void pollSummaries($, summaryCap).catch((error) => {
        $.ui.log(`[lcm] session summarizer stopped: ${String(error)}`);
      });
    }
    return next(e);
  });
}

type RestoreResponse = {
  context?: string;
  insights?: { content: string; confidence: number; tags: string[] }[];
};

/** The text the SessionStart command hook printed: the daemon's context, plus its insights. */
function restoreBlockText(body: Record<string, unknown> | null): string {
  const result = (body ?? {}) as RestoreResponse;
  const context = result.context ?? "";
  const insights = result.insights ?? [];
  if (insights.length === 0) return context;
  const lines = insights.map((i) => `- ${i.content} (confidence: ${i.confidence})`).join("\n");
  return `${context}\n<learned-insights source="passive-capture">\n`
    + `Recent learnings from your previous sessions:\n${lines}\n</learned-insights>`;
}

/**
 * `prompt.context` replaces the SessionStart command hook's stdout. It fires once per
 * conversation and again after compaction and `/clear` — the three moments the command
 * hook ran — but carries no reason for firing, so the daemon decides which content to
 * return from the mark `/compact` left for this session.
 */
function registerRestoreContext(on: On): void {
  on("prompt.context", async ($, e, next) => {
    const { blocks } = await next(e);
    const [session_id, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
    const text = restoreBlockText(await postDaemon($, "/restore", { session_id, cwd }));
    if (!text.trim()) return { blocks };
    return { blocks: [...blocks, { name: "lcm", text }] };
  });
}

/**
 * The learning instruction goes into the system prompt once, cached for the session,
 * instead of riding on every prompt as the command hook's stdout did.
 */
function registerLearningInstruction(on: On): void {
  on("prompt.section", { name: "memory" }, async ($, e, next) => {
    const section = await next(e);
    return { text: `${section.text ?? ""}\n\n${LEARNING_INSTRUCTION}` };
  });
}

/** Memory hits ride as hidden context on the prompt; the user never sees them. */
function registerPromptSearch(on: On): void {
  on("prompt.submit", async ($, e, next) => {
    if (!e.text.trim()) return next(e);
    const [result, search] = await Promise.all([
      next(e),
      Promise.all([$.session.id(), $.session.cwd()]).then(([session_id, cwd]) =>
        postDaemon($, "/prompt-search", {
          query: e.text, cwd, session_id,
          learningInstructionBytes: 0, // the instruction lives in prompt.section now, not in this budget
          recordEvents: true,
          format: "context",
        })),
    ]);
    if (result.drop !== undefined) return result;
    const context = typeof search?.context === "string" ? search.context : null;
    if (!context) return result;
    return { ...result, context: [...(result.context ?? []), context] };
  });
}

/**
 * The session's transcript is ingested incrementally as turns end, so memory does not wait
 * for SessionEnd. The daemon derives the transcript path from session id and cwd.
 */
function registerTurnIngest(on: On): void {
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    const now = Date.now();
    if (now - lastIngestAt < INGEST_INTERVAL_MS) return result;
    lastIngestAt = now;
    const [session_id, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
    await postDaemon($, "/ingest", { session_id, cwd });
    await postDaemon($, "/promote-events", { cwd });
    return result;
  });
}

/** The same body the PostToolUse command hook reads on stdin, so both paths write one row shape. */
function toolEventPayload(
  event: Record<string, unknown>, result: { isError?: boolean; result?: unknown; text?: string },
  session_id: string, cwd: string,
): Record<string, unknown> {
  const { tool, tool_use_id, ...tool_input } = event as { tool: string; tool_use_id: string } & Record<string, unknown>;
  const failed = result.isError === true;
  return {
    session_id, cwd, tool_use_id,
    tool_name: tool,
    tool_input,
    tool_response: result.result,
    tool_output: failed ? { isError: true } : undefined,
    hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
    error: failed ? result.text : undefined,
  };
}

/** One hook replaces both PostToolUse and PostToolUseFailure; the daemon writes the rows. */
function registerToolCapture(on: On): void {
  on("tool.call", async ($, e, next) => {
    const captured = CAPTURED_TOOLS.has(e.tool) || e.tool.startsWith("mcp__");
    if (!captured) return next(e);

    const result = await next(e);
    if (result.deny !== undefined) return result;

    const [session_id, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
    await postDaemon($, "/tool-event", toolEventPayload(e, result, session_id, cwd));
    return result;
  });
}

export const register: Register = (on, options) => {
  const configuredCap = options.sessionSummarizerMaxOutputTokens;
  const summaryCap = typeof configuredCap === "number" && Number.isFinite(configuredCap)
    ? Math.max(0, configuredCap) : DEFAULT_SUMMARY_OUTPUT_CAP;
  registerSessionStart(on, summaryCap);
  registerRestoreContext(on);
  registerLearningInstruction(on);
  registerPromptSearch(on);
  registerTurnIngest(on);
  registerToolCapture(on);
};
