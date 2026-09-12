import { basename, dirname } from "node:path";

/** True when this process runs from the plugin bundle (`bundle/lcm.js`) rather than the npm CLI. */
export function runningFromPluginBundle(entry: string | undefined = process.argv[1]): boolean {
  return Boolean(entry) && basename(entry!) === "lcm.js" && basename(dirname(entry!)) === "bundle";
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
  if (!result.connected) {
    // A marketplace install has no `lcm` on PATH; name the bundle it does have.
    const start = runningFromPluginBundle(entry) ? `node "${entry}" daemon start` : "lcm daemon start";
    return {
      usable: true,
      line: `lcm: daemon did not start on port ${result.port}; memory is off until it does. Repair: ${start}`,
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
