import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

export type DaemonStopDeps = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, enc: string) => string;
  unlinkSync?: (path: string) => void;
  spawnSync?: typeof nodeSpawnSync;
  kill?: (pid: number, signal: number | string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type DaemonStopResult = { exitCode: number; message: string };

export async function handleDaemonStop(
  lcDir: string,
  deps: DaemonStopDeps = {},
): Promise<DaemonStopResult> {
  const fsExists = deps.existsSync ?? existsSync;
  const fsRead = deps.readFileSync ?? ((p: string, enc: string) => readFileSync(p, enc as BufferEncoding) as string);
  const fsUnlink = deps.unlinkSync ?? unlinkSync;
  const spawnFn = deps.spawnSync ?? nodeSpawnSync;
  const killFn = deps.kill ?? ((pid, sig) => process.kill(pid, sig as NodeJS.Signals));
  const sleepFn = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const pidFilePath = join(lcDir, "daemon.pid");

  if (!fsExists(pidFilePath)) {
    return { exitCode: 0, message: "lcm daemon is not running" };
  }

  let pid: number;
  try {
    pid = parseInt(fsRead(pidFilePath, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) throw new Error("invalid");
  } catch {
    try { fsUnlink(pidFilePath); } catch { /* ignore */ }
    return { exitCode: 0, message: "lcm daemon is not running (corrupt pid file)" };
  }

  // Check liveness
  try {
    killFn(pid, 0);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      try { fsUnlink(pidFilePath); } catch { /* ignore */ }
      return { exitCode: 0, message: "lcm daemon is not running (stale pid file)" };
    }
    // EPERM: process exists but we lack permission — proceed
  }

  // Validate process identity before signaling
  try {
    const ps = spawnFn("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf-8" });
    const comm = (ps.stdout as string)?.trim() ?? "";
    if (comm && !comm.includes("node") && !comm.includes("lcm")) {
      return {
        exitCode: 1,
        message: `lcm: PID ${pid} is a different process (${comm}) — aborting to prevent accidental SIGTERM`,
      };
    }
  } catch { /* ps unavailable — proceed */ }

  // Send SIGTERM
  try {
    killFn(pid, "SIGTERM");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      try { fsUnlink(pidFilePath); } catch { /* ignore */ }
      return { exitCode: 0, message: "lcm daemon is not running (stale pid file)" };
    }
    return { exitCode: 1, message: `lcm: failed to send SIGTERM to PID ${pid}` };
  }

  // Poll kill -0 for up to 25 × 200ms = 5s
  let stopped = false;
  for (let i = 0; i < 25; i++) {
    await sleepFn(200);
    try {
      killFn(pid, 0);
    } catch {
      stopped = true;
      break;
    }
  }

  // Escalate to SIGKILL
  if (!stopped) {
    try {
      killFn(pid, "SIGKILL");
      await sleepFn(500);
    } catch { /* already dead */ }
  }

  // PID file removal is always the last step
  try { fsUnlink(pidFilePath); } catch { /* ignore */ }

  return {
    exitCode: 0,
    message: stopped ? "lcm daemon stopped" : "lcm daemon: sent SIGKILL, assuming stopped",
  };
}
