import { homedir } from "node:os";
import { join } from "node:path";

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
  return override || join(homedir(), ".lossless-claude");
}

/** A path inside the lcm home, e.g. `lcmPath("daemon.token")`. */
export function lcmPath(...segments: string[]): string {
  return join(lcmHome(), ...segments);
}
