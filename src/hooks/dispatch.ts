import { validateAndFixHooks } from "./auto-heal.js";

export const HOOK_COMMANDS = ["compact", "post-tool", "restore", "session-end", "session-snapshot", "user-prompt"] as const;
export type HookCommand = typeof HOOK_COMMANDS[number];

export function isHookCommand(cmd: string): cmd is HookCommand {
  return (HOOK_COMMANDS as readonly string[]).includes(cmd);
}

export async function dispatchHook(
  command: HookCommand,
  stdinText: string,
): Promise<{ exitCode: number; stdout: string }> {
  // Early return for post-tool — runs on EVERY tool call, must skip bootstrap for performance
  if (command === "post-tool") {
    const { handlePostToolUse } = await import("./post-tool.js");
    return handlePostToolUse(stdinText);
  }

  // Skip bootstrap for compact — the daemon is already running by the time
  // PreCompact fires (SessionStart ensures it). Skipping saves ~5s of
  // ensureDaemon timeout budget under the hook runner's tight deadline.
  if (command !== "compact") {
    // Lazy bootstrap: create config + start daemon on first hook fire per session
    try {
      const { session_id } = JSON.parse(stdinText || "{}");
      if (session_id) {
        const { ensureBootstrapped } = await import("../bootstrap.js");
        await ensureBootstrapped(session_id);
      }
    } catch {} // bootstrap failure must not block hooks
  }

  validateAndFixHooks();

  const { DaemonClient } = await import("../daemon/client.js");
  const { loadDaemonConfig } = await import("../daemon/config.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
  const port = config.daemon?.port ?? 3737;
  const client = new DaemonClient(`http://127.0.0.1:${port}`);

  switch (command) {
    case "compact": {
      const { handlePreCompact } = await import("./compact.js");
      return handlePreCompact(stdinText, client, port);
    }
    case "restore": {
      const { handleSessionStart } = await import("./restore.js");
      return handleSessionStart(stdinText, client, port);
    }
    case "session-end": {
      const { handleSessionEnd } = await import("./session-end.js");
      return handleSessionEnd(stdinText, client, port);
    }
    case "session-snapshot": {
      const { handleSessionSnapshot } = await import("./session-snapshot.js");
      return handleSessionSnapshot(stdinText);
    }
    case "user-prompt": {
      const { handleUserPromptSubmit } = await import("./user-prompt.js");
      return handleUserPromptSubmit(stdinText, client, port);
    }
    default:
      throw new Error(`Unknown hook command: ${command}`);
  }
}
