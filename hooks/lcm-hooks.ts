// hooks/lcm-hooks.ts — lcm's function-hooks module (Claude Code early access).
//
// Loaded only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. It replaces the PostToolUse and
// PostToolUseFailure command hooks with one `tool.call` hook that runs after the tool
// and hands the call to the daemon's POST /tool-event route. The module has no Node and
// no SQLite, so the daemon writes the events; the command hook stays silent while the
// env var is set (see functionHooksActive in src/hooks/post-tool.ts).
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

type Daemon = { port: number; token: string | null };
let daemon: Promise<Daemon> | null = null;

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

export const register: Register = (on) => {
  on("session.start", ($, e, next) => {
    void readDaemon($);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const captured = CAPTURED_TOOLS.has(e.tool) || e.tool.startsWith("mcp__");
    if (!captured) return next(e);

    const r = await next(e);
    if (r.deny !== undefined) return r;

    const { tool, tool_use_id, ...tool_input } = e as { tool: string; tool_use_id: string } & Record<string, unknown>;
    const failed = r.isError === true;
    const payload = {
      session_id: await $.session.id(),
      cwd: await $.session.cwd(),
      tool_use_id,
      tool_name: tool,
      tool_input,
      tool_response: r.result,
      tool_output: failed ? { isError: true } : undefined,
      hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
      error: failed ? r.text : undefined,
    };

    try {
      const { port, token } = await readDaemon($);
      const res = await $.http.fetch(`http://127.0.0.1:${port}/tool-event`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      if (!res.ok) $.ui.log(`[lcm] tool-event ${tool}: daemon answered ${res.status}`);
    } catch (err) {
      // Daemon down or slow: the call itself is unaffected; only the passive-learning row is lost.
      $.ui.log(`[lcm] tool-event ${tool}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return r;
  });
};
