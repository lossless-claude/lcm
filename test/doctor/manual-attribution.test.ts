import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { projectDir, projectId, claudeProjectSlug } from "../../src/daemon/project.js";
import { updateProjectMeta } from "../../src/daemon/project-meta.js";
import { openStandaloneLcmConnection } from "../../src/db/connection.js";
import { ensureTimelineOwner, TIMELINE_SESSION_ID } from "../../src/db/project-timeline.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { writeHold } from "../../src/daemon/hold.js";

let root: string;
let home: string;
let userHome: string;
let cwd: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(resolve("."), "test-manual-attribution-"));
  home = join(root, "lcm");
  userHome = join(root, "user");
  cwd = join(root, "checkout");
  mkdirSync(cwd);
  const paths = createLcmPaths(home);
  updateProjectMeta(cwd, paths, {});
  dbPath = join(projectDir(cwd, paths), "db.sqlite");
  const db = openStandaloneLcmConnection(dbPath);
  try { runLcmMigrations(db); } finally { db.close(); }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function memory(content: string, sessionId = "manual") {
  const db = openStandaloneLcmConnection(dbPath);
  try {
    return new PromotedStore(db).insert({
      content, projectId: projectId(cwd), sessionId, tags: ["type:decision"], confidence: 0.7,
      depth: 2, sourceSummaryId: "retained-summary-provenance",
    });
  } finally { db.close(); }
}

function row(id: string, path = dbPath) {
  const db = openStandaloneLcmConnection(path, { readOnly: true });
  try { return new PromotedStore(db).getById(id); } finally { db.close(); }
}

/** A store only accepts evidence from sessions it captured. */
function captured(sessionId: string, path = dbPath) {
  const db = openStandaloneLcmConnection(path);
  try { db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run(sessionId); } finally { db.close(); }
}

function claude(sessionId: string, text: string, capturedHere = true) {
  if (capturedHere) captured(sessionId);
  const dir = join(userHome, ".claude", "projects", claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "store-call", name: "mcp__lcm__lcm_store", input: { text } },
    ] },
  }) + "\n");
}

function command(...args: string[]) {
  return execFileSync(process.execPath, [resolve("dist/bin/lcm.js"), "doctor", "--repair-manual-attribution", ...args], {
    cwd: resolve("."), env: { ...process.env, LCM_HOME: home, HOME: userHome }, encoding: "utf8", timeout: 15_000, stdio: "pipe",
  });
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    // SQLite may create WAL coordination files even for read-only connections.
    .filter(entry => entry.isFile() && !/db\.sqlite-(wal|shm)$/.test(entry.name)).map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path, createHash("sha256").update(readFileSync(path)).digest("hex")];
    }));
}

it("previews a unique normalized Claude store call without changing stored data or transcripts", () => {
  const id = memory("Choose SQLite for durable memory.");
  claude("claude-session", "  Choose SQLite\nfor durable memory.  ");
  const before = snapshot(root);
  for (const args of [[], ["--dry-run"]]) {
    const output = command(...args);
    expect(output).toContain("[dry-run]");
    expect(output).toContain(`${id}: attributable -> claude-session`);
    expect(output).toContain("--apply");
    expect(row(id)?.session_id).toBe("manual");
    expect(snapshot(root)).toEqual(before);
  }
});

it("reports matching store calls in several sessions as ambiguous and leaves the memory unchanged", () => {
  const id = memory("Keep the project mutation lease.");
  claude("session-a", "Keep the project mutation lease.");
  claude("session-b", "Keep the project mutation lease.");
  const before = row(id);
  expect(command()).toContain(`${id}: ambiguous -> session-a, session-b`);
  expect(row(id)).toEqual(before);
});

it("leaves memories without a matching store call unchanged, ignoring mentions and other tool arguments", () => {
  const text = "Preserve the original provenance.";
  const id = memory(text);
  const dir = join(userHome, ".claude", "projects", claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mentions.jsonl"), JSON.stringify({
    type: "assistant", message: { content: [
      { type: "text", text },
      { type: "tool_use", name: "mcp__lcm__lcm_search", input: { text } },
      { type: "tool_use", name: "mcp__lcm__lcm_store", input: { text: `A mention: ${text}` } },
    ] },
  }) + "\n");
  const before = row(id);
  const output = command();
  expect(output).toContain(`${dbPath}: 1 unmatched`);
  expect(output).not.toContain(id);
  expect(row(id)).toEqual(before);
});

it.each(["function_call", "custom_tool_call"])("traces Codex %s arguments to the session identity", (type) => {
  const id = memory("Use deterministic fixtures.");
  const dir = join(userHome, ".codex", "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const payload = type === "function_call"
    ? { type, name: "mcp__lcm__lcm_store", arguments: JSON.stringify({ text: "Use deterministic fixtures." }) }
    : { type, name: "lcm_store", input: JSON.stringify({ content: "Use deterministic fixtures." }) };
  captured("codex-session");
  writeFileSync(join(dir, "rollout-codex-session.jsonl"), [
    { type: "session_meta", payload: { id: "codex-session", cwd } },
    { type: "response_item", payload },
    { type: "response_item", payload },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  expect(command()).toContain(`${id}: attributable -> codex-session`);
  expect(row(id)?.session_id).toBe("manual");
});

it("explicit apply changes only the unique memory's session id, retaining a reversible backup", () => {
  const id = memory("Repair only session attribution.");
  const ambiguous = memory("Several sessions stored this.");
  const unmatched = memory("No session stored this.");
  const attributed = memory("Already attributed.", "original-session");
  const archived = memory("Archived memory.");
  const db = openStandaloneLcmConnection(dbPath);
  try { new PromotedStore(db).archive(archived); } finally { db.close(); }
  claude("unique-session", "Repair only session attribution.");
  claude("session-a", "Several sessions stored this.");
  claude("session-b", "Several sessions stored this.");
  claude("archived-session", "Archived memory.");
  const before = row(id);
  const retained = [ambiguous, unmatched, attributed, archived].map(rowId => row(rowId));
  writeHold(createLcmPaths(home).pidPath);

  const output = command("--apply");
  expect(output).toContain("Applied 1 memory attribution");
  expect(output).toContain(`${ambiguous}: ambiguous -> session-a, session-b`);
  expect(output).toContain(`${dbPath}: 1 unmatched`);
  expect(output).not.toContain(archived);
  expect(output).not.toContain(attributed);
  expect(row(id)).toEqual({ ...before, session_id: "unique-session" });
  expect([ambiguous, unmatched, attributed, archived].map(rowId => row(rowId))).toEqual(retained);
  const backups = readdirSync(dirname(dbPath)).filter(name => name.startsWith("db.sqlite.bak-manual-attribution-"));
  expect(backups).toHaveLength(1);
  const backup = join(dirname(dbPath), backups[0]);
  expect(output).toContain(backup);
  expect(row(id, backup)).toEqual(before);
  expect(command("--apply")).toContain("Applied 0 memory attribution");
  expect(readdirSync(dirname(dbPath)).filter(name => name.startsWith("db.sqlite.bak-manual-attribution-"))).toEqual(backups);
});

it.each(["unheld", "running", "activity"])("refuses apply while the daemon is %s, preserving the store", (state) => {
  const id = memory("Require an offline hold before repair.");
  claude("unique-session", "Require an offline hold before repair.");
  const paths = createLcmPaths(home);
  if (state !== "unheld") writeHold(paths.pidPath);
  if (state === "running") writeFileSync(paths.pidPath, String(process.pid));
  if (state === "activity") {
    mkdirSync(paths.tmpDir, { recursive: true });
    writeFileSync(join(paths.tmpDir, `daemon.starting.${process.pid}.fixture`), "");
  }
  const before = snapshot(root);
  expect(() => command("--apply")).toThrow(state === "unheld" ? "lcm daemon stop --hold" : "still running");
  expect(snapshot(root)).toEqual(before);
  expect(row(id)?.session_id).toBe("manual");
});

it("rejects conflicting repair and cleanup flags before touching a store", () => {
  memory("Reject conflicting maintenance modes.");
  const before = snapshot(root);
  expect(() => command("--cleanup-stale-projects")).toThrow("cannot be combined");
  expect(() => command("--apply", "--dry-run")).toThrow("cannot be combined");
  expect(snapshot(root)).toEqual(before);
});

it("leaves a memory unchanged when its only matching session was captured by another store", () => {
  const id = memory("Same text, another project.");
  claude("foreign-session", "Same text, another project.", false);
  const before = row(id);
  const output = command();
  expect(output).toContain(`${dbPath}: 1 matched outside this store`);
  expect(output).not.toContain(`${id}: attributable`);
  expect(row(id)).toEqual(before);
});

it("attributes shared text only in the store that captured the surviving session", () => {
  const paths = createLcmPaths(home);
  const otherCwd = join(root, "other-checkout");
  mkdirSync(otherCwd);
  updateProjectMeta(otherCwd, paths, {});
  const otherDb = join(projectDir(otherCwd, paths), "db.sqlite");
  const db = openStandaloneLcmConnection(otherDb);
  let other: string;
  try {
    runLcmMigrations(db);
    other = new PromotedStore(db).insert({ content: "Shared manual text.", projectId: projectId(otherCwd), sessionId: "manual", tags: [], confidence: 0.7, depth: 2 });
  } finally { db.close(); }
  const here = memory("Shared manual text.");
  claude("surviving-session", "Shared manual text.");
  const output = command();
  expect(output).toContain(`${here}: attributable -> surviving-session`);
  expect(output).toContain(`${otherDb}: 1 matched outside this store`);
  expect(output).not.toContain(`${other}: attributable`);
});

it("reports a broken store as skipped and still processes the stores around it", () => {
  const paths = createLcmPaths(home);
  const otherCwd = join(root, "second-checkout");
  mkdirSync(otherCwd);
  updateProjectMeta(otherCwd, paths, {});
  const otherDb = join(projectDir(otherCwd, paths), "db.sqlite");
  const db = openStandaloneLcmConnection(otherDb);
  let second: string;
  try {
    runLcmMigrations(db);
    db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run("second-session");
    second = new PromotedStore(db).insert({ content: "Second store memory.", projectId: projectId(otherCwd), sessionId: "manual", tags: [], confidence: 0.7, depth: 2 });
  } finally { db.close(); }
  const first = memory("First store memory.");
  claude("first-session", "First store memory.");
  claude("second-session", "Second store memory.", false);
  // Directory names sort; the broken store lands between the two good ones.
  const [low, high] = [projectDir(cwd, paths), projectDir(otherCwd, paths)].sort();
  const broken = `${low}~`;
  expect(broken < high).toBe(true);
  mkdirSync(broken);
  writeFileSync(join(broken, "db.sqlite"), "not a database");
  const output = command();
  expect(output).toContain(`${join(broken, "db.sqlite")}: skipped (`);
  expect(output).toContain(`${first}: attributable -> first-session`);
  expect(output).toContain(`${second}: attributable -> second-session`);
});

it("finds a store call in a nested Claude transcript even when its flat copy lacks it", () => {
  const id = memory("Inspect all available transcript copies.");
  claude("copied-session", "A different memory.");
  const dir = join(userHome, ".claude", "projects", claudeProjectSlug(cwd), "copied-session");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "copied-session.jsonl"), JSON.stringify({
    type: "assistant", message: { content: [
      { type: "tool_use", name: "lcm_store", input: { content: "Inspect all available transcript copies." } },
    ] },
  }) + "\n");
  expect(command()).toContain(`${id}: attributable -> copied-session`);
});


it("ignores store-call evidence attributed to the timeline owner", () => {
  const id = memory("Timeline owners cannot attribute manual memories.");
  const db = openStandaloneLcmConnection(dbPath);
  try { ensureTimelineOwner(db); } finally { db.close(); }
  claude(TIMELINE_SESSION_ID, "Timeline owners cannot attribute manual memories.", false);
  const before = row(id);
  const output = command();
  expect(output).toContain(`${dbPath}: 1 matched outside this store`);
  expect(output).not.toContain(`${id}: attributable`);
  expect(row(id)).toEqual(before);
});


it("accepts captured-session evidence on stores without the timeline column", () => {
  const id = memory("Legacy session attribution remains available.");
  claude("legacy-session", "Legacy session attribution remains available.");
  const db = openStandaloneLcmConnection(dbPath);
  try { db.exec("DROP INDEX timeline_owner_idx; ALTER TABLE conversations DROP COLUMN is_timeline"); }
  finally { db.close(); }
  expect(command()).toContain(`${id}: attributable -> legacy-session`);
});
