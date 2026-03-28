import { join } from "node:path";
import { homedir } from "node:os";
import { projectId } from "../daemon/project.js";

const BASE = join(homedir(), ".lossless-claude");

export function eventsDir(): string {
  return join(BASE, "events");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectId(cwd)}.db`);
}
