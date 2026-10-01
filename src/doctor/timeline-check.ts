import type { CheckResult, DoctorDeps } from "./types.js";
import { createLcmPaths } from "../lcm-paths.js";
import { projectDbPath } from "../daemon/project.js";
import type { SettleReport } from "../project-timeline.js";
import { openStandaloneLcmConnection } from "../db/connection.js";
import { timelineTriggerIssues } from "../db/project-timeline.js";

/** Doctor reads persisted counts through status; it never settles the projection. */
export async function checkProjectTimeline(deps: DoctorDeps, port: number): Promise<CheckResult> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = createLcmPaths(deps.lcmHome);
  const result: CheckResult = { name: "project-timeline", category: "Memory", status: "pass", message: "No project timeline" };
  if (!deps.existsSync(projectDbPath(cwd, paths))) return result;
  let triggers = "";
  try {
    const db = openStandaloneLcmConnection(projectDbPath(cwd, paths), { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'timeline_state'").get()) {
        const state = db.prepare("SELECT tracking FROM timeline_state WHERE id = 1").get() as { tracking: number } | undefined;
        const issues = state?.tracking ? timelineTriggerIssues(db) : [];
        if (issues.length) triggers = `Timeline triggers: ${issues.join('; ')}. Repair with: lcm timeline settle --calls 0 --reconcile full`;
      }
    } finally { db.close(); }
  } catch { triggers = "Timeline triggers unavailable; no repair performed"; }
  try {
    const token = deps.readFileSync(paths.tokenPath, "utf-8").trim();
    const response = await deps.fetch(`http://127.0.0.1:${port}/status`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cwd }),
    });
    if (!response.ok) throw new Error("Timeline status unavailable");
    const status = await response.json() as { project: { timeline?: SettleReport } };
    const report = status.project.timeline;
    if (!report) return { ...result, status: triggers ? "warn" : "pass", message: ["Timeline counts unavailable; no reconciliation performed", triggers].filter(Boolean).join(". ") };
    if (report.calls !== 0 || !Number.isInteger(report.pending) || !Number.isInteger(report.stale)) throw new Error("Unsupported timeline response");
    return { ...result, status: triggers || report.stale || report.pending || report.dirty ? "warn" : "pass",
      message: [`Timeline: ${report.pending} pending, ${report.stale} stale, ${report.dirty ?? 0} dirty sessions; persisted counts, no reconciliation${report.pending ? ". Generate with: lcm timeline settle" : ""}`, triggers].filter(Boolean).join(". ") };
  } catch {
    return { ...result, status: "warn", message: ["Timeline counts unavailable: daemon unavailable or lacks status support", triggers].filter(Boolean).join(". ") };
  }
}
