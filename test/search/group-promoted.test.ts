import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { searchPromotedGroup, logGroupSurfacing } from "../../src/search/group-promoted.js";
import { openProject } from "../../src/daemon/project-group.js";
import { projectDbPath, projectId } from "../../src/daemon/project.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import * as migration from "../../src/db/migration.js";
import { resetMigrationMemo } from "../../src/search/migrated-connection.js";
import { getPoolStats } from "../../src/db/connection.js";
import { RecallStore } from "../../src/db/recall.js";

/** An isolated base dir, so these tests never touch the developer's own store. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-union-base-")));
const paths: LcmPaths = createLcmPaths(base);

const tempDirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); resetMigrationMemo(); for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A checkout of `remote` whose promoted memory holds `contents`. */
function checkout(remote: string, contents: string[]): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-union-repo-")));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
  openProject(cwd, paths);

  const dbPath = projectDbPath(cwd, paths);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    for (const content of contents) store.insert({ content, tags: ["decision"], projectId: "p1" });
  } finally { db.close(); }
  return cwd;
}

const LCM = "git@github.com:lossless-claude/lcm.git";

describe("searchPromotedGroup", () => {
  it("yields between every member after releasing its connection", async () => {
    const remote = "https://github.com/lossless-claude/yield-fixture.git";
    const here = checkout(remote, ["compaction"]);
    checkout(remote, []);
    checkout(remote, ["compaction"]);
    const visits: number[] = [];
    const search = vi.spyOn(PromotedStore.prototype, "search");
    const yieldBetweenMembers = vi.fn(async () => {
      expect(getPoolStats().activeConnections).toBe(0);
      visits.push(search.mock.calls.length);
    });

    await searchPromotedGroup(here, { query: "compaction", limit: 10, yieldBetweenMembers }, paths);

    expect(yieldBetweenMembers).toHaveBeenCalledTimes(2);
    expect(visits).toEqual([1, 2]);
  });

  it("skips feedback for many empty and nonmatching members without migrating current stores", async () => {
    const remote = "https://github.com/lossless-claude/empty-fixture.git";
    const here = checkout(remote, []);
    for (let member = 0; member < 11; member++) checkout(remote, member % 2 ? [] : ["unrelated vocabulary"]);
    const feedback = vi.spyOn(RecallStore.prototype, "getFeedback");
    const migrations = vi.spyOn(migration, "runLcmMigrations");
    const yieldBetweenMembers = vi.fn(async () => {});

    const result = await searchPromotedGroup(here, { query: "compaction", limit: 10, withFeedback: true, yieldBetweenMembers }, paths);
    await searchPromotedGroup(here, { query: "compaction", limit: 10, withFeedback: true }, paths);

    expect(result.hits).toEqual([]);
    expect(feedback).not.toHaveBeenCalled();
    expect(migrations.mock.calls.length).toBe(0);
    expect(yieldBetweenMembers).toHaveBeenCalledTimes(11);
  });

  it("returns the same multi-member hits, ranks and feedback asynchronously", async () => {
    const remote = "https://github.com/lossless-claude/results-fixture.git";
    const here = checkout(remote, ["compaction alpha", "compaction beta"]);
    const sibling = checkout(remote, ["compaction gamma", "compaction delta"]);
    const expectedIds: string[] = [];
    for (const cwd of [here, sibling]) {
      const db = new DatabaseSync(projectDbPath(cwd, paths));
      const found = new PromotedStore(db).search("compaction", 10);
      expectedIds.push(...found.map(hit => hit.id));
      db.prepare("INSERT INTO promoted(id, content, tags, project_id) VALUES (?, 'used', ?, 'p1')")
        .run(`signal-${found[0].id}`, JSON.stringify(["signal:memory_used", `memory_id:${found[0].id}`]));
      db.prepare("INSERT INTO recall_surfacing(memory_id, surfaced_at) VALUES (?, '2026-01-01 00:00:00')").run(found[0].id);
      db.close();
    }
    const pending = searchPromotedGroup(here, { query: "compaction", limit: 3, withFeedback: true }, paths);
    expect(pending).toBeInstanceOf(Promise);
    const { hits, feedback } = await pending;

    expect(hits.map(hit => hit.id)).toEqual([expectedIds[0], expectedIds[2], expectedIds[1]]);
    expect(hits.map(hit => hit.content)).toEqual(["compaction alpha", "compaction gamma", "compaction beta"]);
    expect(hits.map(hit => hit.rank)).toEqual([0.000001, 0.000001, 0.000001]);
    expect(hits.map(hit => hit.project.cwd)).toEqual([here, sibling, here]);
    expect(feedback).toEqual(new Map(expectedIds.map((id, index) => [id, {
      usageCount: index % 2 === 0 ? 1 : 0,
      surfacingCount: index % 2 === 0 ? 1 : 0,
      lastSurfacedAt: index % 2 === 0 ? "2026-01-01 00:00:00" : null,
    }])));
  });

  it("upgrades an older store once and retains its existing usage feedback", async () => {
    const here = checkout("https://github.com/lossless-claude/old-feedback-fixture.git", ["compaction"]);
    const db = new DatabaseSync(projectDbPath(here, paths));
    const memoryId = new PromotedStore(db).search("compaction", 1)[0].id;
    db.exec(`DROP TRIGGER recall_usage_insert; DROP TRIGGER recall_usage_update;
      DROP TRIGGER recall_usage_delete; DROP TABLE recall_usage;`);
    db.prepare("INSERT INTO promoted(id, content, tags, project_id) VALUES ('old-signal', 'used', ?, 'p1')")
      .run(JSON.stringify(["signal:memory_used", `memory_id:${memoryId}`]));
    db.close();
    const migrations = vi.spyOn(migration, "runLcmMigrations");

    for (let prompt = 0; prompt < 2; prompt++) {
      const { feedback } = await searchPromotedGroup(here, { query: "compaction", limit: 10, withFeedback: true }, paths);
      expect(feedback.get(memoryId)?.usageCount).toBe(1);
    }
    expect(migrations.mock.calls.length).toBe(1);
  });

  it("returns memories held by a sibling checkout of the same repository", async () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout("https://github.com/lossless-claude/lcm.git", ["compaction is the only LLM step"]);

    const contents = (await searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths)).hits.map(h => h.content);
    expect(contents).toHaveLength(2);
    expect(contents).toContain("compaction runs lazily");
    expect(contents).toContain("compaction is the only LLM step");
    expect(sibling).toBeTruthy();
  });

  it("names the checkout each memory came from", async () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step"]);

    const byContent = new Map(
      (await searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths)).hits.map(h => [h.content, h.project]),
    );
    expect(byContent.get("compaction runs lazily")).toEqual({ id: projectId(here), cwd: here });
    expect(byContent.get("compaction is the only LLM step")).toEqual({ id: projectId(sibling), cwd: sibling });
  });

  it("leaves a lone project's own ranking untouched", async () => {
    const alone = checkout("git@github.com:lossless-claude/only-me.git", ["compaction runs lazily", "compaction of nothing"]);

    const db = new DatabaseSync(projectDbPath(alone, paths));
    const expected = new PromotedStore(db).search("compaction", 10);
    db.close();

    const hits = (await searchPromotedGroup(alone, { query: "compaction", limit: 10 }, paths)).hits;
    expect(hits.map(h => h.id)).toEqual(expected.map(r => r.id));
    expect(hits.map(h => h.rank)).toEqual(expected.map(r => r.rank));
  });

  it("does not reach a checkout of a different repository", async () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    checkout("git@github.com:lossless-claude/magi.git", ["compaction elsewhere"]);

    const contents = (await searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths)).hits.map(h => h.content);
    expect(contents).toEqual(["compaction runs lazily"]);
  });

  it("reads each memory's recall feedback from the database that holds it", async () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step"]);

    const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
    const siblingId = new PromotedStore(siblingDb).search("compaction", 1)[0].id;
    new RecallStore(siblingDb).logSurfacing([siblingId], "session-1");
    siblingDb.close();

    const { feedback } = await searchPromotedGroup(here, { query: "compaction", limit: 10, withFeedback: true }, paths);
    expect(feedback.get(siblingId)?.surfacingCount).toBe(1);
  });

});

describe("logGroupSurfacing", () => {
  it("writes a sibling's surfacing into the sibling's own database", async () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step"]);

    const hits = (await searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths)).hits;
    const fromSibling = hits.find(h => h.project.cwd === sibling)!;
    logGroupSurfacing(hits, [fromSibling.id], "session-1", paths);

    const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
    const hereDb = new DatabaseSync(projectDbPath(here, paths));
    try {
      expect(new RecallStore(siblingDb).getFeedback([fromSibling.id]).get(fromSibling.id)?.surfacingCount).toBe(1);
      expect(new RecallStore(hereDb).getFeedback([fromSibling.id]).get(fromSibling.id)?.surfacingCount).toBe(0);
    } finally { siblingDb.close(); hereDb.close(); }
  });
});
