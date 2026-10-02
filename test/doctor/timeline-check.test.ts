import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { checkProjectTimeline } from "../../src/doctor/timeline-check.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { projectDbPath } from "../../src/daemon/project.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { enableTimeline } from "../../src/db/project-timeline.js";

it("doctor requests only persisted status counts and never reconciliation", async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ project: { timeline: { calls: 0, stale: 2, pending: 1 } } }) }));
  const deps = { cwd: "/project", lcmHome: "/memory", existsSync: () => true, readFileSync: () => "test-token", fetch };
  expect(await checkProjectTimeline(deps as never, 1000)).toMatchObject({ name: "project-timeline", status: "warn" });
  expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:1000/status");
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ cwd: "/project" });
});

it("doctor reports missing and outdated triggers read-only before migration repairs them", async () => {
  const paths = createLcmPaths(process.env.LCM_HOME!);
  const path = projectDbPath("/project", paths);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    runLcmMigrations(db);
    enableTimeline(db);
    db.exec(`DROP TRIGGER timeline_messages_insert_new;
      DROP TRIGGER timeline_summaries_delete_old;
      DROP TRIGGER timeline_messages_update_new;
      CREATE TRIGGER timeline_messages_update_new AFTER UPDATE ON messages BEGIN SELECT 1; END;`);
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ project: { timeline: { calls: 0, stale: 0, pending: 0, dirty: 0 } } }) }));
    const deps = { cwd: "/project", lcmHome: paths.home, existsSync, readFileSync: () => "test-token", fetch };
    const report = await checkProjectTimeline(deps as never, 1000);
    expect(report.status).toBe("warn");
    expect(report.message).toContain("missing: timeline_messages_insert_new");
    expect(report.message).toContain("missing: timeline_summaries_delete_old");
    expect(report.message).toContain("outdated: timeline_messages_update_new");
    expect(report.message).toContain("lcm timeline settle --calls 0 --reconcile full");
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.prepare("SELECT phase FROM timeline_state").get()).toMatchObject({ phase: "bootstrapping" });
    runLcmMigrations(db);
    expect(await checkProjectTimeline(deps as never, 1000)).toMatchObject({ status: "pass" });
  } finally { db.close(); }
});

it.each([[3, 1, "warn"], [0, 2, "warn"], [0, 0, "pass"]])(
  "doctor separates %s pending units from %s months awaiting replan",
  async (pending, replanMonths, status) => {
    const paths = createLcmPaths(process.env.LCM_HOME!);
    const path = projectDbPath("/counts", paths);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db);
      const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ project: {
        timeline: { calls: 0, stale: 0, dirty: 0, pending, replanMonths },
      } }) }));
      const deps = { cwd: "/counts", lcmHome: paths.home, existsSync, readFileSync: () => "test-token", fetch };
      const report = await checkProjectTimeline(deps as never, 1000);
      expect(report.status).toBe(status);
      expect(report.message).toContain(`${pending} pending units, ${replanMonths} months awaiting replan`);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:1000/status");
    } finally { db.close(); }
  },
);
