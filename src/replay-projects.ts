import { projectId } from "./daemon/project.js";

/** Replay concurrency is across projects; each project's ordered list stays serial. */
export function replayParallelism(options: { replay?: boolean; parallel?: number; replayProvider?: string }): number {
  const parallel = options.parallel ?? 1;
  if (!Number.isSafeInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  if (options.replayProvider !== undefined && options.replayProvider !== "session-pool") {
    throw new Error("--replay-provider must be session-pool");
  }
  if (!options.replay && (parallel !== 1 || options.replayProvider !== undefined)) {
    throw new Error("--parallel and --replay-provider require --replay");
  }
  return parallel;
}

export async function runReplayProjects<T>(
  items: T[], cwdOf: (item: T) => string, parallel: number, work: (ordered: T[]) => Promise<void>,
): Promise<void> {
  if (parallel === 1) { await work(items); return; }
  const projects = new Map<string, T[]>();
  for (const item of items) {
    const id = projectId(cwdOf(item));
    const ordered = projects.get(id) ?? [];
    ordered.push(item);
    projects.set(id, ordered);
  }
  const pending = [...projects.values()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, async () => {
    while (next < pending.length) await work(pending[next++]);
  }));
}
