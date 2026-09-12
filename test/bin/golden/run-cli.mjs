/**
 * Runs the built CLI as its own process group so a deadline can kill the whole
 * tree, not just the direct child. `spawnSync`'s `timeout` only signals the
 * child it spawned — a command that forks (or is later replaced by one that
 * does) can outlive the deadline. Shared by test/bin/golden.test.ts and
 * scripts/golden-capture.mjs so both kill the same way.
 *
 * Never resolves with `status: null` unless the caller checks `signal` and
 * `timedOut` too: a timeout, a signal exit or a spawn error means the process
 * did not complete cleanly, and callers must treat that as a failure.
 */
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10000;

// Every child's process-group leader pid still running, so the runner can
// clean them all up if it dies (or is killed) before a case's own deadline.
const liveChildPids = new Set();
let lifecycleHandlersRegistered = false;

function killChildProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

function killAllLiveChildren() {
  for (const pid of liveChildPids) killChildProcessGroup(pid);
}

/** Registered once regardless of how many times runCli() is called. */
function registerLifecycleHandlersOnce() {
  if (lifecycleHandlersRegistered) return;
  lifecycleHandlersRegistered = true;

  process.on("exit", killAllLiveChildren);
  process.on("SIGINT", () => {
    killAllLiveChildren();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killAllLiveChildren();
    process.exit(143);
  });
}

/**
 * @param {string[]} argv - full argv for `process.execPath`, e.g. [CLI_ENTRY, ...caseArgv].
 * @param {string} stdin - input written to the child's stdin, then ended.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {Promise<{stdout: string, stderr: string, status: number|null, signal: string|null, timedOut: boolean}>}
 */
export function runCli(argv, stdin, env, cwd) {
  registerLifecycleHandlersOnce();

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (typeof child.pid === "number") liveChildPids.add(child.pid);

    // Decode as whole UTF-8 characters across chunk boundaries; concatenating
    // raw Buffers with `+=` decodes each chunk separately, so a multi-byte
    // character split across two chunks would come out as U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killChildProcessGroup(child.pid);
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (typeof child.pid === "number") liveChildPids.delete(child.pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (status, signal) => {
      if (typeof child.pid === "number") liveChildPids.delete(child.pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, status, signal, timedOut });
    });

    child.stdin.on("error", () => {
      /* EPIPE when the child exits before stdin is fully written; the close
         handler above is what determines the outcome. */
    });
    child.stdin.write(stdin ?? "");
    child.stdin.end();
  });
}
