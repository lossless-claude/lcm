import { join } from "node:path";
import { projectId } from "../daemon/project.js";
import { lcmHome } from "../lcm-home.js";

const BASE = lcmHome();

export function eventsDir(): string {
  return join(BASE, "events");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectId(cwd)}.db`);
}
