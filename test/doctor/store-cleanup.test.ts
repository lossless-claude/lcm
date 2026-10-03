import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { checkStaleProjectStores, cleanupStaleProjectStores } from "../../src/doctor/store-hygiene.js";
import { DatabaseSync } from "node:sqlite";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { projectDir, projectId } from "../../src/daemon/project.js";
import { recordProjectIdentity, groupIndexPath } from "../../src/daemon/project-group.js";
import { updateProjectMeta, updateProjectMetaIn } from "../../src/daemon/project-meta.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { clearHold, writeHold } from "../../src/daemon/hold.js";

const interleave = vi.hoisted(() => ({
  afterListing: undefined as (() => void) | undefined,
  afterMove: undefined as ((from: string) => void) | undefined,
  projectsDir: "",
  listings: 0,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      const entries = actual.readdirSync(...args);
      if (String(args[0]) === interleave.projectsDir) {
        interleave.listings++;
        const callback = interleave.afterListing;
        interleave.afterListing = undefined;
        callback?.();
      }
      return entries;
    },
    renameSync: (from: string, to: string) => {
      actual.renameSync(from, to);
      interleave.afterMove?.(from);
    },
  };
});

let home: string;
beforeEach(() => { home = mkdtempSync(join(resolve("."), "test-store-cleanup-")); });
afterEach(() => {
  interleave.afterListing = undefined;
  interleave.afterMove = undefined;
  interleave.projectsDir = "";
  interleave.listings = 0;
  rmSync(home, { recursive: true, force: true });
});

function fixture(cwd: string) {
  const paths = createLcmPaths(home);
  updateProjectMeta(cwd, paths, { git: { remotes: ["https://example.invalid/fixture.git"], relPath: "", checkedAt: new Date().toISOString() } });
  recordProjectIdentity(cwd, paths);
  writeFileSync(join(projectDir(cwd, paths), "db.sqlite"), "preserved memory");
  mkdirSync(paths.eventsDir, { recursive: true });
  writeFileSync(eventsDbPath(cwd, paths), "preserved events");
  writeFileSync(eventsDbPath(cwd, paths) + "-wal", "preserved event WAL");
  return paths;
}

function command(...args: string[]): string {
  return execFileSync(process.execPath, [resolve("dist/bin/lcm.js"), "doctor", ...args], {
    cwd: resolve("."), env: { ...process.env, LCM_HOME: home }, encoding: "utf8", timeout: 15_000, stdio: "pipe",
  });
}

it("apply verifies its offline hold before listing project records", () => {
  const paths = fixture(join(home, "lossless-status-gone"));
  interleave.projectsDir = paths.projectsDir;
  expect(() => cleanupStaleProjectStores(paths, true)).toThrow("Requires an offline hold");
  expect(interleave.listings).toBe(0);
});

it("apply reports a hold released between listing and moving without moving anything", () => {
  const cwd = join(home, "lossless-status-gone");
  const paths = fixture(cwd);
  writeHold(paths.pidPath);
  interleave.projectsDir = paths.projectsDir;
  interleave.afterListing = () => clearHold(paths.pidPath);
  expect(() => cleanupStaleProjectStores(paths, true)).toThrow(/offline hold lost; moved 0 paths/);
  expect(readFileSync(join(projectDir(cwd, paths), "db.sqlite"), "utf8")).toBe("preserved memory");
  expect(readFileSync(eventsDbPath(cwd, paths), "utf8")).toBe("preserved events");
  expect(existsSync(join(home, "trash"))).toBe(false);
});

it.each([["mid-batch", 1], ["between batches", 3]] as const)(
  "apply stops when its hold is released %s and reports recoverable moves",
  (_boundary, expectedMoves) => {
    const paths = fixture(join(home, "lossless-status-first"));
    fixture(join(home, "lossless-status-second"));
    const [firstId, secondId] = readdirSync(paths.projectsDir);
    const firstStore = join(paths.projectsDir, firstId);
    writeHold(paths.pidPath);
    const moved: string[] = [];
    interleave.afterMove = from => {
      moved.push(from);
      if (moved.length === expectedMoves) clearHold(paths.pidPath);
    };
    let message = "";
    try { cleanupStaleProjectStores(paths, true); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain(`offline hold lost; moved ${expectedMoves} path`);
    expect(moved).toHaveLength(expectedMoves);
    expect(message).toContain(firstStore + " -> ");
    expect(message).toContain("Trash directory:");
    expect(existsSync(firstStore)).toBe(false);
    expect(readFileSync(join(paths.projectsDir, secondId, "db.sqlite"), "utf8")).toBe("preserved memory");
    expect(readFileSync(join(paths.eventsDir, secondId + ".db"), "utf8")).toBe("preserved events");
    const trashRoot = join(home, "trash", "projects");
    const batch = join(trashRoot, readdirSync(trashRoot)[0]);
    expect(readFileSync(join(batch, firstId, "db.sqlite"), "utf8")).toBe("preserved memory");
    const eventsDir = expectedMoves === 1 ? paths.eventsDir : join(batch, "events");
    expect(readFileSync(join(eventsDir, firstId + ".db"), "utf8")).toBe("preserved events");
    expect(readFileSync(join(eventsDir, firstId + ".db-wal"), "utf8")).toBe("preserved event WAL");
    const index = new DatabaseSync(groupIndexPath(paths), { readOnly: true });
    try {
      expect(index.prepare("SELECT project_id FROM project_identity ORDER BY project_id").all())
        .toEqual([firstId, secondId].sort().map(project_id => ({ project_id })));
    } finally { index.close(); }
  },
);

it("cleanup stops restoring files if its hold is lost during rollback", () => {
  const cwd = join(home, "lossless-compact-gone");
  const paths = fixture(cwd);
  const db = new DatabaseSync(groupIndexPath(paths));
  try { db.exec("DROP TABLE project_identity"); } finally { db.close(); }
  writeHold(paths.pidPath);
  const moved: string[] = [];
  interleave.afterMove = from => {
    moved.push(from);
    if (moved.length === 4) clearHold(paths.pidPath);
  };
  expect(() => cleanupStaleProjectStores(paths, true)).toThrow("offline hold lost");
  // Three forward moves, then one restoration before the release.
  expect(moved).toHaveLength(4);
  expect(existsSync(projectDir(cwd, paths))).toBe(false);
  const trashRoot = join(home, "trash", "projects");
  const batch = join(trashRoot, readdirSync(trashRoot)[0]);
  expect(readFileSync(join(batch, projectId(cwd), "db.sqlite"), "utf8")).toBe("preserved memory");
});

it("cleanup defaults to a dry run and preserves stores, sidecars and group-index references", () => {
  const cwd = join(home, "lossless-status-gone");
  const paths = fixture(cwd);
  for (const args of [["--cleanup-stale-projects"], ["--cleanup-stale-projects", "--dry-run"]]) {
    const before = readdirSync(home).sort();
    const output = command(...args);
    expect(output).toContain("[dry-run]");
    expect(output).toContain(cwd);
    expect(output).toContain("--apply");
    expect(readdirSync(home).sort()).toEqual(before);
    expect(readFileSync(join(projectDir(cwd, paths), "db.sqlite"), "utf8")).toBe("preserved memory");
    expect(readFileSync(eventsDbPath(cwd, paths), "utf8")).toBe("preserved events");
    const db = new DatabaseSync(groupIndexPath(paths), { readOnly: true });
    try { expect(db.prepare("SELECT project_id FROM project_identity").all()).toEqual([{ project_id: projectId(cwd) }]); }
    finally { db.close(); }
  }
});

it("explicit apply moves stale stores and sidecars to trash and removes only their index references", () => {
  const cwd = join(home, "lossless-compact-gone");
  const paths = fixture(cwd);
  const normal = "/workspace/retained-repository";
  fixture(normal);
  const active = join(home, "e2e-test-active");
  mkdirSync(active);
  fixture(active);
  writeHold(paths.pidPath);
  const output = command("--cleanup-stale-projects", "--apply");
  expect(output).toContain("Trashed 1 project store");
  expect(existsSync(projectDir(cwd, paths))).toBe(false);
  expect(existsSync(eventsDbPath(cwd, paths))).toBe(false);
  expect(existsSync(eventsDbPath(cwd, paths) + "-wal")).toBe(false);
  const trashRoot = join(home, "trash", "projects");
  const batch = join(trashRoot, readdirSync(trashRoot)[0]);
  expect(readFileSync(join(batch, projectId(cwd), "db.sqlite"), "utf8")).toBe("preserved memory");
  expect(readFileSync(join(batch, "events", projectId(cwd) + ".db"), "utf8")).toBe("preserved events");
  expect(readFileSync(join(batch, "events", projectId(cwd) + ".db-wal"), "utf8")).toBe("preserved event WAL");
  for (const kept of [normal, active]) expect(existsSync(projectDir(kept, paths))).toBe(true);
  const db = new DatabaseSync(groupIndexPath(paths), { readOnly: true });
  try {
    for (const table of ["project_identity", "project_remote"]) {
      expect(db.prepare(`SELECT project_id FROM ${table} ORDER BY project_id`).all())
        .toEqual([normal, active].map(projectId).sort().map(project_id => ({ project_id })));
    }
  } finally { db.close(); }
});

it("apply refuses an unheld or running daemon and incompatible flags without moving a store", () => {
  const cwd = join(home, "lossless-ingest-gone");
  const paths = fixture(cwd);
  expect(() => command("--cleanup-stale-projects", "--apply")).toThrow("lcm daemon stop --hold");
  writeHold(paths.pidPath);
  writeFileSync(paths.pidPath, String(process.pid));
  expect(() => command("--cleanup-stale-projects", "--apply")).toThrow("daemon is still running");
  expect(() => command("--cleanup-stale-projects", "--apply", "--dry-run")).toThrow("cannot be combined");
  expect(existsSync(projectDir(cwd, paths))).toBe(true);
});

it("a failed index update restores the store and sidecars and rolls back index changes", () => {
  const cwd = join(home, "lossless-compact-gone");
  const paths = fixture(cwd);
  const db = new DatabaseSync(groupIndexPath(paths));
  try { db.exec("DROP TABLE project_identity"); } finally { db.close(); }
  writeHold(paths.pidPath);
  expect(() => command("--cleanup-stale-projects", "--apply")).toThrow("no such table");
  expect(readFileSync(join(projectDir(cwd, paths), "db.sqlite"), "utf8")).toBe("preserved memory");
  expect(readFileSync(eventsDbPath(cwd, paths), "utf8")).toBe("preserved events");
  expect(readFileSync(eventsDbPath(cwd, paths) + "-wal", "utf8")).toBe("preserved event WAL");
  const after = new DatabaseSync(groupIndexPath(paths), { readOnly: true });
  try { expect(after.prepare("SELECT project_id FROM project_remote").all()).toEqual([{ project_id: projectId(cwd) }]); }
  finally { after.close(); }
});

it("apply refuses a live database activity marker even when the daemon has no pid file", () => {
  const cwd = join(home, "lossless-ingest-gone");
  const paths = fixture(cwd);
  writeHold(paths.pidPath);
  mkdirSync(paths.tmpDir, { recursive: true });
  writeFileSync(join(paths.tmpDir, `daemon.starting.${process.pid}.fixture`), "");
  expect(() => command("--cleanup-stale-projects", "--apply")).toThrow("database activity is still running");
  expect(existsSync(projectDir(cwd, paths))).toBe(true);
});

it("cleanup retains an invalid project record instead of guessing its cwd", () => {
  const paths = createLcmPaths(home);
  const dir = join(paths.projectsDir, "invalid-record");
  updateProjectMetaIn(dir, { cwd: "e2e-test-relative" });
  writeFileSync(join(dir, "db.sqlite"), "preserved memory");
  writeHold(paths.pidPath);
  expect(command("--cleanup-stale-projects", "--apply")).toContain("Trashed 0 project stores");
  expect(readFileSync(join(dir, "db.sqlite"), "utf8")).toBe("preserved memory");
  expect(existsSync(join(home, "trash"))).toBe(false);
});

it("reports and trashes a vanished cwd alias using the store's recorded id", () => {
  // Test-named directories, so the store qualifies wherever the suite's working directory is.
  const target = join(home, "e2e-test-checkout");
  const cwd = join(home, "e2e-test-cwd-alias");
  mkdirSync(target);
  symlinkSync(target, cwd);
  const paths = fixture(cwd);
  const store = projectDir(cwd, paths);
  const id = basename(store);
  const events = eventsDbPath(cwd, paths);
  rmSync(cwd);
  rmSync(target, { recursive: true });
  expect(projectId(cwd)).not.toBe(id);
  expect(command("--cleanup-stale-projects", "--dry-run")).toContain("Would trash 1 project stores");
  writeHold(paths.pidPath);
  expect(command("--cleanup-stale-projects", "--apply")).toContain("Trashed 1 project store");
  expect(existsSync(store)).toBe(false);
  expect(existsSync(events)).toBe(false);
  const db = new DatabaseSync(groupIndexPath(paths), { readOnly: true });
  try { expect(db.prepare("SELECT project_id FROM project_identity").all()).toEqual([]); }
  finally { db.close(); }
});

it("flags a gone store recorded under the temporary directory's real path", async () => {
  // Stored cwds are realpaths; on macOS tmpdir() is /var/folders/…, a symlink to /private/var/folders/….
  const cwd = join(realpathSync(tmpdir()), `lcm-gone-${randomUUID()}`);
  const paths = fixture(cwd);
  expect(await checkStaleProjectStores(paths)).toMatchObject({ status: "warn", message: expect.stringContaining(cwd) });
});
