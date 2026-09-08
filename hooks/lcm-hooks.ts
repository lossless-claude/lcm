// hooks/lcm-hooks.ts — lcm's function-hooks module (Claude Code early access).
//
// Loaded only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. While it is loaded, the PostToolUse,
// PostToolUseFailure and UserPromptSubmit command hooks stay silent (functionHooksActive in
// src/hooks/post-tool.ts) and this module does their work through the daemon:
//   tool.call       → POST /tool-event    (the daemon writes the passive-learning rows)
//   prompt.submit   → POST /prompt-search (memory hits ride as hidden context on the prompt)
//   prompt.section  → the learning instruction is appended once to the system prompt's
//                     `memory` section, instead of to every prompt.
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

export const register: Register = (on) => {
  on("session.start", ($, e, next) => {
    // Warm up: read the daemon's address and make sure it is listening before the first prompt,
    // without depending on the SessionStart command hook having done it.
    void readDaemon($).then(({ port }) =>
      $.http.fetch(`http://127.0.0.1:${port}/health`).then(() => undefined, () => startDaemon($)));
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
