import { join } from "node:path";
import { projectId } from "../daemon/project.js";
import { defaultLcmPaths } from "../lcm-paths.js";

export function eventsDir(): string {
  return defaultLcmPaths.eventsDir;
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectId(cwd)}.db`);
}
