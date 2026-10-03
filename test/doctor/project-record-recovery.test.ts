import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { checkStaleProjectStores, cleanupStaleProjectStores } from "../../src/doctor/store-hygiene.js";
import { updateProjectMetaIn } from "../../src/daemon/project-meta.js";
import { writeHold } from "../../src/daemon/hold.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "lcm-record-recovery-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function store(id: string, projectId?: string): string {
  const dir = join(createLcmPaths(home).projectsDir, id);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  try {
    runLcmMigrations(db);
    if (projectId) new PromotedStore(db).insert({ content: "Bash error: preserved learning", projectId });
  } finally { db.close(); }
  return dir;
}

it("doctor counts record-less stores and those holding promoted memories without changing them", async () => {
  const dir = store("a".repeat(64), "unknown-project");
  store("b".repeat(64));
  const before = readFileSync(join(dir, "db.sqlite"));
  const result = await checkStaleProjectStores(createLcmPaths(home));
  expect(result.status).toBe("warn");
  expect(result.message).toContain("2 record-less project stores; 1 hold promoted memories");
  expect(result.message).toContain("lcm doctor --cleanup-stale-projects --dry-run");
  expect(readFileSync(join(dir, "db.sqlite"))).toEqual(before);
  expect(existsSync(join(dir, "meta.json"))).toBe(false);
});

it("cleanup preview offers a cwd from a promoted row's known project id without repairing or moving it", () => {
  const knownId = "c".repeat(64);
  const cwd = "/workspace/known-checkout";
  updateProjectMetaIn(store(knownId), { cwd });
  const id = "a".repeat(64);
  const dir = store(id, knownId);
  const before = readFileSync(join(dir, "db.sqlite"));
  const preview = cleanupStaleProjectStores(createLcmPaths(home));
  expect(preview).toContain(`${id}: recoverable cwd ${cwd}`);
  expect(preview).toContain("review and restore the project record manually");
  expect(readFileSync(join(dir, "db.sqlite"))).toEqual(before);
  expect(existsSync(join(dir, "meta.json"))).toBe(false);
});

it("cleanup preview recovers structured cwd evidence from an older database without migrating it", () => {
  const paths = createLcmPaths(home);
  const id = "d".repeat(64);
  const dir = join(paths.projectsDir, id);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  try {
    db.exec("CREATE TABLE conversations (cwd TEXT)");
    db.prepare("INSERT INTO conversations VALUES (?)").run("/workspace/legacy-checkout");
  } finally { db.close(); }
  const before = readFileSync(join(dir, "db.sqlite"));
  expect(cleanupStaleProjectStores(paths)).toContain(`${id}: recoverable cwd /workspace/legacy-checkout`);
  expect(readFileSync(join(dir, "db.sqlite"))).toEqual(before);
  expect(existsSync(join(dir, "meta.json"))).toBe(false);
});

it("doctor leaves promoted-memory counts unknown for unreadable databases", async () => {
  const paths = createLcmPaths(home);
  const dir = join(paths.projectsDir, "f".repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "db.sqlite"), "not a database");
  const message = (await checkStaleProjectStores(paths)).message;
  expect(message).toContain("1 record-less project stores; 0 hold promoted memories");
  expect(message).toContain("Promoted memories not checked in 1 unreadable databases");
});

it("cleanup does not guess when rows identify different known working directories", () => {
  const first = "c".repeat(64), second = "e".repeat(64);
  updateProjectMetaIn(store(first), { cwd: "/workspace/first" });
  updateProjectMetaIn(store(second), { cwd: "/workspace/second" });
  const dir = store("a".repeat(64), first);
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  try { new PromotedStore(db).insert({ content: "A second owner's memory", projectId: second }); }
  finally { db.close(); }
  expect(cleanupStaleProjectStores(createLcmPaths(home))).not.toContain("recoverable cwd");
});

it("explicit cleanup preserves record-less stores and event sidecars even with a recoverable missing temporary cwd", () => {
  const paths = createLcmPaths(home);
  const cwd = join(home, "missing-checkout");
  const id = "a".repeat(64);
  const dir = store(id);
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  try {
    db.exec("CREATE TABLE legacy_context (cwd TEXT)");
    db.prepare("INSERT INTO legacy_context VALUES (?)").run(cwd);
  } finally { db.close(); }
  mkdirSync(paths.eventsDir, { recursive: true });
  const sidecar = join(paths.eventsDir, `${id}.db`);
  writeFileSync(sidecar, "preserved events");
  const before = readFileSync(join(dir, "db.sqlite"));
  expect(cleanupStaleProjectStores(paths)).toContain(`${id}: recoverable cwd ${cwd}`);
  writeHold(paths.pidPath);
  expect(cleanupStaleProjectStores(paths, true)).toContain("Trashed 0 project stores");
  expect(readFileSync(join(dir, "db.sqlite"))).toEqual(before);
  expect(readFileSync(sidecar, "utf8")).toBe("preserved events");
  expect(existsSync(join(dir, "meta.json"))).toBe(false);
  expect(existsSync(join(home, "trash"))).toBe(false);
});
