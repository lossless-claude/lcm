import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "./config.js";
import type { LcmPaths } from "../lcm-paths.js";
import { openProjectTimeline, type ProjectTimeline } from "../project-timeline.js";
import { enqueue, withProjectMutation } from "./project-queue.js";
import { projectId } from "./project.js";
import { createSummarizer, resolveEffectiveProvider } from "./summarizer.js";
import type { SummarizeJobStore } from "./summarize-jobs.js";
import { TIMELINE_SESSION_ID, recoverTimelineAdmission } from "../db/project-timeline.js";

const activeTimelines = new Set<string>();
export const TIMELINE_ADMISSION_ERROR = "Timeline provider chain requires bounded HTTP admission: configure every provider and fallback as a named openai or anthropic endpoint with maxConcurrent";
export function hasTimelineWork(pid: string): boolean { return activeTimelines.has(pid); }

/** Each acquisition owns a separate queue turn; none encloses a model call. */
export function daemonTimeline(db: DatabaseSync, cwd: string, config: DaemonConfig, _paths: LcmPaths, jobs?: Pick<SummarizeJobStore, "enqueue">): ProjectTimeline {
  const pid = projectId(cwd);
  const provider = resolveEffectiveProvider(config);
  let summarize: ReturnType<typeof createSummarizer> | undefined;
  const timeline = openProjectTimeline(db, {
    lease: work => enqueue(pid, () => withProjectMutation(pid, work)),
    summarize: async (text, aggressive, context) => {
      summarize ??= createSummarizer(provider, config, jobs);
      const fn = await summarize;
      if (!fn) throw new Error("Timeline summarizer is disabled");
      // Pool jobs are claimed globally; ordinary session jobs need a live harness.
      return fn(text, aggressive, { ...context, ...(provider === "session-pool" ? { sessionId: TIMELINE_SESSION_ID } : {}) });
    },
  });
  return {
    bootstrap: async () => {
      if (activeTimelines.has(pid)) throw new Error("Project timeline is already settling");
      activeTimelines.add(pid);
      try { await timeline.bootstrap(); }
      finally { activeTimelines.delete(pid); }
    },
    describe: id => timeline.describe(id),
    settle: async budget => {
      if (budget.calls > 0 && !timelineProviderAdmitted(config)) throw new Error(TIMELINE_ADMISSION_ERROR);
      if (activeTimelines.has(pid)) throw new Error("Project timeline is already settling");
      activeTimelines.add(pid);
      try {
        if (budget.calls > 0) await enqueue(pid, () => withProjectMutation(pid, async () => recoverTimelineAdmission(db)));
        return await timeline.settle(budget);
      } finally { activeTimelines.delete(pid); }
    },
  };

}

const DEBOUNCE_MS = 60_000;
const REPLAY_HOLD_MS = 300_000;

/** Every possible adapter must provide the same live/background/timeline admission. */
export function timelineProviderAdmitted(config: DaemonConfig): boolean {
  if (config.summarizer.mock) return true;
  if (!config.llm.providers) return false;
  const names = [resolveEffectiveProvider(config), ...(config.llm.fallback ?? [])];
  const runnable = names.map(name => config.llm.providers![name])
    .filter(endpoint => !endpoint || !("missingEnv" in endpoint) || !endpoint.missingEnv?.length);
  return runnable.length > 0 && runnable.every(endpoint =>
    endpoint && (endpoint.type === "openai" || endpoint.type === "anthropic") && endpoint.maxConcurrent !== undefined);
}

/** Clock-only admission; counts and diagnostics never enter this path. */
export async function timelineTick(db: DatabaseSync, timeline: ProjectTimeline, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const state = db.prepare("SELECT tracking, generation, phase FROM timeline_state WHERE id = 1").get() as { tracking: number; generation: number; phase: string };
  if (!state.tracking || !state.generation) return;
  if (state.phase === "bootstrapping") {
    await timeline.bootstrap();
    return;
  }
  if (state.phase !== "ready") return;
  const latest = db.prepare("SELECT MAX(bumped_at) at FROM timeline_dirty").get() as { at: string | null };
  if (latest.at && Date.now() - Date.parse(latest.at) < DEBOUNCE_MS) return;
  if (replayHeld(db)) return;
  await timeline.settle({ calls: 1 });
}
function replayHeld(db: DatabaseSync): boolean {
  const latest = db.prepare("SELECT run_id FROM replay_manifest ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { run_id: string } | undefined;
  if (!latest) return false;
  const remaining = db.prepare(`SELECT 1 FROM replay_manifest m WHERE m.run_id = ? AND NOT EXISTS
    (SELECT 1 FROM replay_ledger l WHERE l.run_id = m.run_id AND l.session_id = m.session_id) LIMIT 1`).get(latest.run_id);
  if (!remaining) return false;
  const progress = db.prepare(`SELECT MAX(unixepoch(at)) seconds FROM (SELECT MAX(completed_at) at FROM replay_ledger WHERE run_id = ?
    UNION ALL SELECT MAX(created_at) at FROM replay_manifest WHERE run_id = ?)`).get(latest.run_id, latest.run_id) as { seconds: number };
  return Date.now() - progress.seconds * 1000 < REPLAY_HOLD_MS;
}
