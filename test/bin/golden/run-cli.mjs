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

/**
 * @param {string[]} argv - full argv for `process.execPath`, e.g. [CLI_ENTRY, ...caseArgv].
 * @param {string} stdin - input written to the child's stdin, then ended.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {Promise<{stdout: string, stderr: string, status: number|null, signal: string|null, timedOut: boolean}>}
 */
export function runCli(argv, stdin, env, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* process group already gone */
      }
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (status, signal) => {
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
