import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { searchPromotedGroup, logGroupSurfacing } from "../../src/search/group-promoted.js";
import { openProject } from "../../src/daemon/project-group.js";
import { projectDbPath, projectId } from "../../src/daemon/project.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { RecallStore } from "../../src/db/recall.js";

/** An isolated base dir, so these tests never touch the developer's own store. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-union-base-")));
const paths: LcmPaths = createLcmPaths(base);

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
  it("returns memories held by a sibling checkout of the same repository", () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout("https://github.com/lossless-claude/lcm.git", ["compaction is the only LLM step"]);

    const contents = searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths).hits.map(h => h.content);
    expect(contents).toHaveLength(2);
    expect(contents).toContain("compaction runs lazily");
    expect(contents).toContain("compaction is the only LLM step");
    expect(sibling).toBeTruthy();
  });

  it("names the checkout each memory came from", () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step"]);

    const byContent = new Map(
      searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths).hits.map(h => [h.content, h.project]),
    );
    expect(byContent.get("compaction runs lazily")).toEqual({ id: projectId(here), cwd: here });
    expect(byContent.get("compaction is the only LLM step")).toEqual({ id: projectId(sibling), cwd: sibling });
  });

  it("leaves a lone project's own ranking untouched", () => {
    const alone = checkout("git@github.com:lossless-claude/only-me.git", ["compaction runs lazily", "compaction of nothing"]);

    const db = new DatabaseSync(projectDbPath(alone, paths));
    const expected = new PromotedStore(db).search("compaction", 10);
    db.close();

    const hits = searchPromotedGroup(alone, { query: "compaction", limit: 10 }, paths).hits;
    expect(hits.map(h => h.id)).toEqual(expected.map(r => r.id));
    expect(hits.map(h => h.rank)).toEqual(expected.map(r => r.rank));
  });

  it("does not reach a checkout of a different repository", () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    checkout("git@github.com:lossless-claude/magi.git", ["compaction elsewhere"]);

    const contents = searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths).hits.map(h => h.content);
    expect(contents).toEqual(["compaction runs lazily"]);
  });

  it("reads each memory's recall feedback from the database that holds it", () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step"]);

    const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
    const siblingId = new PromotedStore(siblingDb).search("compaction", 1)[0].id;
    new RecallStore(siblingDb).logSurfacing([siblingId], "session-1");
    siblingDb.close();

    const { feedback } = searchPromotedGroup(here, { query: "compaction", limit: 10, withFeedback: true }, paths);
    expect(feedback.get(siblingId)?.surfacingCount).toBe(1);
  });
});

describe("logGroupSurfacing", () => {
  it("writes a sibling's surfacing into the sibling's own database", () => {
    const here = checkout(LCM, ["compaction runs lazily"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step"]);

    const hits = searchPromotedGroup(here, { query: "compaction", limit: 10 }, paths).hits;
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
