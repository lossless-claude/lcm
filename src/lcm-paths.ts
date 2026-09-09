import { join } from "node:path";
import { lcmHome } from "./lcm-home.js";

/**
 * Every location lcm owns, derived from one root.
 *
 * The point of the object is that the root arrives as an argument. Code that holds an
 * `LcmPaths` cannot read the environment behind your back, and a test builds one over a
 * temp directory instead of mocking a module or setting a variable — so two tests can run
 * against two roots at once.
 *
 * Paths derived from a project's cwd stay in `daemon/project.ts`, which owns the hashing.
 */
export type LcmPaths = {
  readonly home: string;
  readonly projectsDir: string;
  readonly eventsDir: string;
  readonly logsDir: string;
  readonly tmpDir: string;
  readonly configPath: string;
  readonly tokenPath: string;
  readonly pidPath: string;
};

export function createLcmPaths(home: string): LcmPaths {
  return {
    home,
    projectsDir: join(home, "projects"),
    eventsDir: join(home, "events"),
    logsDir: join(home, "logs"),
    tmpDir: join(home, "tmp"),
    configPath: join(home, "config.json"),
    tokenPath: join(home, "daemon.token"),
    pidPath: join(home, "daemon.pid"),
  };
}

/**
 * The process-wide instance, for code that has not been given one yet.
 *
 * Resolved once, so every caller agrees on the root even though some read it at load and
 * others per call. It is scaffolding for the migration in #409, not the destination: the
 * last step there deletes it, and after that the type system is what stops a path from
 * being read out of the ambient environment.
 */
export const defaultLcmPaths: LcmPaths = createLcmPaths(lcmHome());
