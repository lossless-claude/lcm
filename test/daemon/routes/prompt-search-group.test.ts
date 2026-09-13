import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/** An isolated base dir, so these tests never touch the developer's own store. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-prompt-search-group-base-")));
// The group index is resolved from the storage root, not from this file's project mock,
// and `createDaemon` builds its own LcmPaths — so the root itself has to point here.
process.env.LCM_HOME = base;
vi.mock("../../../src/daemon/project.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/daemon/project.js")>();
  const dirOf = (cwd: string) => join(base, "projects", original.projectId(cwd));
  return {
    ...original,
    BASE_DIR: base,
    projectDir: dirOf,
    projectDbPath: (cwd: string) => join(dirOf(cwd), "db.sqlite"),
    projectMetaPath: (cwd: string) => join(dirOf(cwd), "meta.json"),
    ensureProjectDir: (cwd: string) => { mkdirSync(dirOf(cwd), { recursive: true }); return dirOf(cwd); },
  };
});

const { createDaemon } = await import("../../../src/daemon/server.js");
const { loadDaemonConfig } = await import("../../../src/daemon/config.js");
const { runLcmMigrations } = await import("../../../src/db/migration.js");
const { PromotedStore } = await import("../../../src/db/promoted.js");
const { projectDbPath, projectId } = await import("../../../src/daemon/project.js");
const { openProject, resolveSourceCwd } = await import("../../../src/daemon/project-group.js");
const { createLcmPaths } = await import("../../../src/lcm-paths.js");

const paths = createLcmPaths(base);

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A checkout of `remote` whose promoted memory holds `contents`. */
function checkout(remote: string, contents: string[]): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-prompt-search-group-repo-")));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
  openProject(cwd, paths);

  const dbPath = projectDbPath(cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    for (const content of contents) store.insert({ content, tags: ["decision"], projectId: "p1" });
  } finally { db.close(); }
  return cwd;
}

const LCM = "git@github.com:lossless-claude/prompt-search-group.git";

describe("POST /prompt-search across a project group", () => {
  it("qualifies a sibling's surfaced id with its project, and leaves a local one bare", async () => {
    const here = checkout(LCM, ["compaction runs lazily here"]);
    const sibling = checkout(LCM, ["compaction is the only LLM step over there"]);

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "compaction", cwd: here, format: "context" }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        projectIds: (string | null)[];
        context: string;
      };
      expect(res.status).toBe(200);
      expect(data.ids).toHaveLength(2);

      const hereIndex = data.hints.findIndex((hint) => hint.includes("here"));
      const siblingIndex = data.hints.findIndex((hint) => hint.includes("there"));
      expect(hereIndex).toBeGreaterThanOrEqual(0);
      expect(siblingIndex).toBeGreaterThanOrEqual(0);

      // The local hint's id carries no project.
      expect(data.projectIds[hereIndex]).toBeFalsy();
      // The sibling's id is tagged with the project it came from.
      const siblingProjectId = data.projectIds[siblingIndex];
      expect(siblingProjectId).toBe(projectId(sibling));

      // The rendered comment encodes both forms, and resolving the sibling's
      // project id against the requesting cwd lands on the sibling's own database
      // — the same lookup `lcm_describe`/`lcm_expand` perform via `projectId`.
      expect(data.context).toContain(`<!-- surfaced-memory-ids: `);
      expect(data.context).toContain(`${data.ids[siblingIndex]}@${siblingProjectId}`);
      expect(data.context).not.toMatch(new RegExp(`${data.ids[hereIndex]}@`));
      expect(resolveSourceCwd(here, siblingProjectId, paths)).toBe(sibling);
    } finally {
      await daemon.stop();
    }
  });
});
