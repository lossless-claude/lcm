import { join } from "node:path";
import { projectId } from "../daemon/project.js";
import type { LcmPaths } from "../lcm-paths.js";

export function eventsDir(paths: LcmPaths): string {
  return paths.eventsDir;
}

export function eventsDbPath(cwd: string, paths: LcmPaths): string {
  return join(eventsDir(paths), `${projectId(cwd)}.db`);
}
