import { execFileSync } from "node:child_process";
import { basename } from "node:path";

type ProcessIdentity = { parent: number; executable: string; startedAt: string };
type ReadProcess = (pid: number) => ProcessIdentity;
const MAX_ANCESTORS = 16;

/** Read process identity only; command arguments and environment may contain secrets. */
function readProcess(pid: number): ProcessIdentity {
  const options = { encoding: "utf8" as const, timeout: 1500, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  const line = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,comm="], options).trim();
  const match = /^(\d+)\s+(.+)$/.exec(line);
  if (!match) throw new Error("Process identity unavailable");
  const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], options).trim();
  if (!startedAt) throw new Error("Process start time unavailable");
  return { parent: Number(match[1]), executable: match[2], startedAt };
}

/** Shell wrappers change per invocation; the native harness and its start time do not. */
export function workerHookOwner(client: "claude" | "codex", read: ReadProcess = readProcess, parentPid = process.ppid): string {
  let pid = parentPid;
  try {
    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
      const identity = read(pid);
      const name = basename(identity.executable);
      const native = client === "claude" ? /^claude(?:\.exe)?$/i : /^codex(?:-[a-z0-9_-]+)?(?:\.exe)?$/i;
      if (native.test(name)) return `${client}-command:${pid}:${identity.startedAt}`;
      if (identity.parent === pid) break;
      pid = identity.parent;
    }
  } catch { /* An unreadable process cannot establish a live owner. */ }
  throw new Error("Worker hook process ownership is unverified. Use the native harness with lcm hooks; Claude Code can use function hooks for enrollment.");
}
