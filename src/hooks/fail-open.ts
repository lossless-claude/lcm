import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lcmPath } from "../lcm-home.js";

/**
 * Writes `line` to stderr the first time it is called for `sessionId`; later calls in
 * the same session are silent. The mark lives in lcm's tmp dir, like the bootstrap flag.
 */
export function warnOncePerSession(sessionId: string, key: string, line: string): void {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flag = lcmPath("tmp", `notice-${key}-${safeId}.flag`);
  try {
    if (existsSync(flag)) return;
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, "");
  } catch { /* a mark that cannot be written just means the line may repeat */ }
  process.stderr.write(line + "\n");
}

/**
 * True when this process runs from the plugin bundle (`bundle/lcm.js` or
 * `bundle/mcp-server.js`) rather than the npm CLI: the directory is named `bundle`
 * and carries both entries, so a stray directory of that name does not qualify.
 */
export function runningFromPluginBundle(entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  const dir = dirname(entry);
  return basename(dir) === "bundle" && existsSync(join(dir, "lcm.js")) && existsSync(join(dir, "mcp-server.js"));
}

/** The bundle's CLI next to whichever bundle entry is running; the npm CLI otherwise. */
function cliInvocation(entry: string | undefined): string {
  return runningFromPluginBundle(entry) ? `node "${join(dirname(entry!), "lcm.js")}"` : "lcm";
}

/** The command that brings this distribution of lcm up to date. */
export function repairCommand(entry: string | undefined = process.argv[1]): string {
  return runningFromPluginBundle(entry)
    ? "claude plugin update lcm@lossless-claude"
    : "npm install -g @lossless-claude/lcm@latest";
}

export type DaemonNotice = { line: string; usable: boolean };

/**
 * The one line a hook writes to stderr when it cannot fully run, and whether the
 * hooks of this session may still use the daemon.
 */
export function daemonNotice(
  result: { connected: boolean; port: number; ownership?: string; daemonVersion?: string },
  callerVersion: string | undefined,
  entry: string | undefined = process.argv[1],
): DaemonNotice | undefined {
  const mine = callerVersion ?? "unknown";
  if (result.ownership === "incompatible") {
    return {
      usable: false,
      line: `lcm: daemon v${result.daemonVersion} is newer than this hook (v${mine}) and incompatible; memory is off for this session. Repair: ${repairCommand(entry)}`,
    };
  }
  if (!result.connected && result.ownership === "restart") {
    // A caller that may not spawn met an older daemon: it is running, just not replaced yet.
    return {
      usable: true,
      line: `lcm: daemon v${result.daemonVersion} is older than this hook (v${mine}); the next hook that may start one replaces it. Repair: ${cliInvocation(entry)} daemon restart`,
    };
  }
  if (!result.connected) {
    // A marketplace install has no `lcm` on PATH; name the bundle it does have.
    return {
      usable: true,
      line: `lcm: daemon did not start on port ${result.port}; memory is off until it does. Repair: ${cliInvocation(entry)} daemon start`,
    };
  }
  if (result.ownership === "older-caller") {
    return {
      usable: true,
      line: `lcm: daemon v${result.daemonVersion} is newer than this hook (v${mine}); connected. Update with: ${repairCommand(entry)}`,
    };
  }
  return undefined;
}
