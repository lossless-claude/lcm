import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkUncapturedTranscripts, SETTLED_MS } from "../../src/doctor/transcript-check.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { markSessionComplete } from "../../src/capture.js";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { claudeProjectSlug, ensureProjectDir, projectDbPath, projectId } from "../../src/daemon/project.js";
import { updateProjectMeta } from "../../src/daemon/project-meta.js";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

let root: string;
let paths: LcmPaths;
let claudeProjectsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-transcript-check-"));
  paths = createLcmPaths(join(root, "lcm"));
  claudeProjectsDir = join(root, "claude-projects");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A project lcm tracks: its `meta.json` and a migrated database. */
function trackedProject(name: string): { cwd: string; db: DatabaseSync } {
  const cwd = join(root, "work", name);
  mkdirSync(cwd, { recursive: true });
  ensureProjectDir(cwd, paths);
  updateProjectMeta(cwd, paths, { cwd });
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  runLcmMigrations(db);
  return { cwd, db };
}

function storeMessage(db: DatabaseSync, sessionId: string): void {
  const { conversation_id } = db.prepare("INSERT INTO conversations (session_id) VALUES (?) RETURNING conversation_id").get(sessionId) as { conversation_id: number };
  db.prepare("INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, 0, 'user', 'hi', 1)").run(conversation_id);
}

/** A Claude Code transcript last modified `ageMs` before NOW. */
function transcript(cwd: string, sessionId: string, ageMs: number): string {
  const dir = join(claudeProjectsDir, claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
  const at = (NOW - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

const check = (cwd: string) => checkUncapturedTranscripts({ paths, claudeProjectsDir, cwd, now: NOW });

describe("checkUncapturedTranscripts", () => {
  it("warns about settled transcripts of a tracked project with nothing stored, naming the count and the most recent", () => {
    const { cwd, db } = trackedProject("a");
    transcript(cwd, "older-missing", 3 * HOUR_MS);
    const newest = transcript(cwd, "newer-missing", 2 * HOUR_MS);
    db.close();

    const result = check(join(root, "elsewhere"));
    expect(result.status).toBe("warn");
    expect(result.category).toBe("Capture");
    expect(result.message).toContain(`${cwd}: 2 transcripts, most recent ${newest}`);
    expect(result.message).toContain("lcm import --provider claude");
  });

  it("does not count a stored session, a completed one, or one modified within the settle margin", () => {
    const { cwd, db } = trackedProject("a");
    transcript(cwd, "stored", HOUR_MS);
    storeMessage(db, "stored");
    transcript(cwd, "completed-empty", HOUR_MS);
    markSessionComplete(db, "completed-empty", 0);
    transcript(cwd, "in-progress", SETTLED_MS - 60_000);
    db.close();

    const result = check(join(root, "elsewhere"));
    expect(result.status).toBe("pass");
  });

  it("counts a completed session whose transcript changed since only when nothing of it is stored", () => {
    const { cwd, db } = trackedProject("a");
    markSessionComplete(db, "resumed-unstored", 0);
    db.prepare("UPDATE session_ingest_log SET completed_at = '2026-01-10 08:00:00.000'").run();
    const path = transcript(cwd, "resumed-unstored", 2 * HOUR_MS);
    db.close();

    const result = check(join(root, "elsewhere"));
    expect(result.status).toBe("warn");
    expect(result.message).toContain(`${cwd}: 1 transcript, most recent ${path}`);
  });

  it("reports the current directory's transcripts when lcm has no project for it", () => {
    const cwd = join(root, "work", "untracked");
    mkdirSync(cwd, { recursive: true });
    const path = transcript(cwd, "never", HOUR_MS);

    const result = check(cwd);
    expect(result.status).toBe("warn");
    expect(result.message).toContain(`${cwd}: 1 transcript, most recent ${path}`);
  });

  it("passes when there is nothing to check", () => {
    expect(check(join(root, "elsewhere")).status).toBe("pass");
  });

  it("counts a subagent transcript whose session has nothing stored, as `lcm import` finds it", () => {
    const { cwd, db } = trackedProject("a");
    transcript(cwd, "parent", HOUR_MS);
    storeMessage(db, "parent");
    db.close();
    const subagentDir = join(claudeProjectsDir, claudeProjectSlug(cwd), "parent", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const path = join(subagentDir, "agent-1.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "task" } })}\n`);
    writeFileSync(join(subagentDir, "agent-1.meta.json"), JSON.stringify({ agentType: "Explore" }));
    const at = (NOW - HOUR_MS) / 1000;
    utimesSync(path, at, at);

    expect(check(join(root, "elsewhere")).message).toContain(`${cwd}: 1 transcript, most recent ${path}`);
  });

  it("skips a file among the project directories", () => {
    const { cwd, db } = trackedProject("a");
    db.close();
    writeFileSync(join(paths.projectsDir, ".DS_Store"), "");
    const path = transcript(cwd, "missing", HOUR_MS);

    expect(check(join(root, "elsewhere")).message).toContain(`${cwd}: 1 transcript, most recent ${path}`);
  });

  it("lists projects sharing one Claude Code project directory as not checked instead of blaming either", () => {
    const first = trackedProject("a-b");
    const second = trackedProject("a_b");
    storeMessage(first.db, "captured-in-first");
    first.db.close();
    second.db.close();
    transcript(first.cwd, "captured-in-first", HOUR_MS);

    const result = check(join(root, "elsewhere"));
    expect(result.status).toBe("warn");
    expect(result.message).not.toContain("with nothing stored");
    expect(result.message).toContain(`${first.cwd} (shares its Claude Code project directory)`);
    expect(result.message).toContain(`${second.cwd} (shares its Claude Code project directory)`);
  });

  it("reports a project whose meta.json cannot be read and still checks the others", () => {
    const broken = trackedProject("broken");
    broken.db.close();
    const brokenDir = join(paths.projectsDir, projectId(broken.cwd));
    rmSync(join(brokenDir, "meta.json"));
    mkdirSync(join(brokenDir, "meta.json"));
    const { cwd, db } = trackedProject("a");
    db.close();
    const path = transcript(cwd, "missing", HOUR_MS);

    const result = check(join(root, "elsewhere"));
    expect(result.message).toContain(`${cwd}: 1 transcript, most recent ${path}`);
    expect(result.message).toContain(`Not checked: ${brokenDir}`);
  });

  it("checks the current directory when its project directory exists without a readable meta.json", () => {
    const { cwd, db } = trackedProject("current");
    db.close();
    rmSync(join(paths.projectsDir, projectId(cwd), "meta.json"));
    const path = transcript(cwd, "missing", HOUR_MS);

    expect(check(cwd).message).toContain(`${cwd}: 1 transcript, most recent ${path}`);
  });
});
