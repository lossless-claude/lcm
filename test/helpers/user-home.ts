import { vi } from "vitest";

// `os.homedir()` reads HOME on POSIX but USERPROFILE on Windows, so a test that moves only HOME
// still resolves the test process's own home there. A child is no different: on Windows libuv
// copies the parent's USERPROFILE into a child env that lacks one, even an env built from
// scratch. These move both; test/home-stub-discipline.test.ts refuses HOME set any other way.

/** Moves this test's home to `dir` until `vi.unstubAllEnvs()`. */
export function stubUserHome(dir: string): void {
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
}

/** `base` with its home moved to `dir`, for a child process. */
export function childEnvWithHome(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // HOMEDRIVE and HOMEPATH need no keys here: libuv copies both from the parent into a child env
  // that lacks them, so what keeps them out of every child is test/setup-env.ts deleting them
  // from the worker.
  return { ...base, HOME: dir, USERPROFILE: dir };
}
