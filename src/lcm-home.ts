import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Where lcm keeps everything it owns: the daemon's port, token and pid, the per-project
 * databases, the events sidecars, the logs.
 *
 * `LCM_HOME` points all of it somewhere else. Without that override the only way to run
 * lcm against a scratch directory is to move `HOME` itself, which takes the host's own
 * configuration with it — so a sandbox for lcm could not be built without breaking the
 * tool under test. Read on every call, so a test can set and clear it.
 */
export function lcmHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LCM_HOME?.trim();
  const home = override || join(homedir(), ".lossless-claude");
  assertIsolatedTestHome(home);
  return home;
}

/** Test setup retains the OS user's real root before isolating HOME; children inherit it. */
export function assertIsolatedTestHome(home: string): void {
  const protectedHome = process.env.LCM_TEST_REAL_HOME;
  if (!protectedHome) return;
  const realHome = resolve(protectedHome);
  const inside = (path: string) => path === realHome || path.startsWith(realHome + sep);
  if (inside(resolve(home)) || inside(resolveExistingPath(home))) {
    throw new Error("[lcm test guard] refused the real lcm home; use an isolated test directory");
  }
}

/** Resolve symlinked ancestors even when the target home has not been created. */
function resolveExistingPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolveExistingPath(parent), basename(absolute));
  }
}
