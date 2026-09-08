// hooks/lcm-hooks.ts — lcm's function-hooks module (Claude Code early access).
//
// Loaded only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. While it is loaded, the PostToolUse,
// PostToolUseFailure and UserPromptSubmit command hooks stay silent (functionHooksActive in
// src/hooks/post-tool.ts) and this module does their work through the daemon:
//   tool.call       → POST /tool-event    (the daemon writes the passive-learning rows)
//   prompt.submit   → POST /prompt-search (memory hits ride as hidden context on the prompt)
//   prompt.section  → the learning instruction is appended once to the system prompt's
//                     `memory` section, instead of to every prompt.
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

type Daemon = { port: number; token: string | null };
let daemon: Promise<Daemon> | null = null;
/** Routes the running daemon answered 404 for: an older lcm build. Logged once each, not per call. */
const missingRoutes = new Set<string>();

// The daemon's port and bearer token live under ~/.lossless-claude, outside $.fs's
// reach (project and temp dir only), so a host command reads them once per module load.
function readDaemon($: EngineInterface): Promise<Daemon> {
  daemon ??= $.process.run(["sh", "-c",
    'cat "$HOME/.lossless-claude/daemon.token" 2>/dev/null; echo; echo "__CONFIG__"; cat "$HOME/.lossless-claude/config.json" 2>/dev/null',
  ]).then(({ stdout }) => {
    const [tokenPart, configPart = ""] = stdout.split("__CONFIG__");
    const token = tokenPart.trim() || null;
    let port = DEFAULT_PORT;
    try { port = JSON.parse(configPart).daemon?.port ?? DEFAULT_PORT; } catch { /* no config: default */ }
    return { port, token };
  }, () => ({ port: DEFAULT_PORT, token: null }));
  return daemon;
}

/** Last time this module asked the host to start the daemon; one attempt per cooldown window. */
let lastDaemonStartAt = 0;
const DAEMON_START_COOLDOWN_MS = 60_000;
const DAEMON_START_TIMEOUT_MS = 15_000;
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
  if (run?.exitCode === 127 && !warnedNoLcmBinary) {
    warnedNoLcmBinary = true;
    $.ui.log("[lcm] daemon is down and no `lcm` binary is on PATH to start it; events are lost until a command hook restarts it");
  } else if (run && run.exitCode !== 127) {
    $.ui.log(`[lcm] daemon start failed (exit ${run.exitCode}): ${run.stderr.trim().split("\n")[0] ?? ""}`);
  }
  return false;
}

type PostOutcome = { body: Record<string, unknown> | null; connectionFailed: boolean };

async function postOnce($: EngineInterface, route: string, body: unknown): Promise<PostOutcome> {
  try {
    const { port, token } = await readDaemon($);
    const res = await $.http.fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      if (!missingRoutes.has(route)) {
        missingRoutes.add(route);
        $.ui.log(`[lcm] daemon has no ${route} route (older lcm build); the command hooks still record`);
      }
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
let summaryPollerStarted = false;

function summaryDelay($: EngineInterface, ms: number): Promise<void> {
  return new Promise((resolve) => { $.clock.after(ms, resolve); });
}

async function completeSummary($: EngineInterface, job: SummaryJob): Promise<SummaryAnswer> {
  const text = await $.model.complete({
    model: "haiku", system: job.system, prompt: job.prompt, maxTokens: job.maxTokens,
  });
  return {
    text: text.trim(), providerId: "session:haiku",
    usage: {
      input_tokens: Math.ceil((job.system.length + job.prompt.length) / 4),
      output_tokens: Math.ceil(text.length / 4), estimated: true,
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

/** One request at a time also serializes jobs from concurrent daemon compactions. */
async function pollSummaries($: EngineInterface, cap: number): Promise<void> {
  const sessionId = await $.session.id();
  let spent = 0;
  let shortPoll = false;
  while (true) {
    if (shortPoll) await summaryDelay($, 2_000);
    let job: SummaryJob;
    try {
      const { port, token } = await readDaemon($);
      const response = await $.http.fetch(
        `http://127.0.0.1:${port}/summarize-jobs/next?session_id=${encodeURIComponent(sessionId)}${shortPoll ? "&wait_ms=0" : ""}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (response.status === 204) continue;
      if (response.status === 404) {
        $.ui.log("[lcm] daemon has no session summarizer route (older lcm build)");
        return;
      }
      if (!response.ok) {
        if (response.status === 401) daemon = null;
        $.ui.log(`[lcm] /summarize-jobs/next: daemon answered ${response.status}`);
        await summaryDelay($, 5_000);
        continue;
      }
      job = JSON.parse(response.text).job as SummaryJob;
      // Do not run a prompt belonging to another session, even on a malformed response.
      if (!job || job.session_id !== sessionId) {
        $.ui.log("[lcm] discarded summary job for a different session");
        await summaryDelay($, 5_000);
        continue;
      }
    } catch {
      // Some hosts cap HTTP request duration below the daemon's 25-second hold.
      shortPoll = true;
      await startDaemon($);
      daemon = null; // A restarted daemon may have a new bearer token.
      await summaryDelay($, 5_000);
      continue;
    }

    const route = `/summarize-jobs/${encodeURIComponent(job.id)}`;
    if (spent >= cap) {
      await postDaemon($, route, { error: "spend cap" });
      return;
    }
    try {
      const answer = await answerSummary($, job);
      spent += answer.usage.output_tokens;
      if (spent > cap) {
        await postDaemon($, route, { error: "spend cap" });
        return;
      }
      if (!answer.text) throw new Error("empty summary");
      await postDaemon($, route, answer);
    } catch (error) {
      await postDaemon($, route, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const register: Register = (on, options) => {
  const configuredCap = options.sessionSummarizerMaxOutputTokens;
  const summaryCap = typeof configuredCap === "number" && Number.isFinite(configuredCap)
    ? Math.max(0, configuredCap) : DEFAULT_SUMMARY_OUTPUT_CAP;
  on("session.start", ($, e, next) => {
    // Warm up: read the daemon's address and make sure it is listening before the first prompt,
    // without depending on the SessionStart command hook having done it.
    void readDaemon($).then(({ port }) =>
      $.http.fetch(`http://127.0.0.1:${port}/health`).then(() => undefined, () => startDaemon($)));
    if (summaryCap > 0 && !summaryPollerStarted) {
      summaryPollerStarted = true;
      void pollSummaries($, summaryCap).catch((error) => {
        $.ui.log(`[lcm] session summarizer stopped: ${String(error)}`);
      });
    }
    return next(e);
  });

  // The learning instruction goes into the system prompt once, cached for the session,
  // instead of riding on every prompt as the command hook's stdout did.
  on("prompt.section", { name: "memory" }, async ($, e, next) => {
    const section = await next(e);
    return { text: `${section.text ?? ""}\n\n${LEARNING_INSTRUCTION}` };
  });

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

  // The session's transcript is ingested incrementally as turns end, so memory does not wait
  // for SessionEnd. The daemon derives the transcript path from session id and cwd.
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

  on("tool.call", async ($, e, next) => {
    const captured = CAPTURED_TOOLS.has(e.tool) || e.tool.startsWith("mcp__");
    if (!captured) return next(e);

    const result = await next(e);
    if (result.deny !== undefined) return result;

    const { tool, tool_use_id, ...tool_input } = e as { tool: string; tool_use_id: string } & Record<string, unknown>;
    const failed = result.isError === true;
    const [session_id, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
    await postDaemon($, "/tool-event", {
      session_id, cwd, tool_use_id,
      tool_name: tool,
      tool_input,
      tool_response: result.result,
      tool_output: failed ? { isError: true } : undefined,
      hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
      error: failed ? result.text : undefined,
    });
    return result;
  });
};
