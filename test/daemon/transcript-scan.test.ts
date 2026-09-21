// test/daemon/transcript-scan.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { scanForTranscripts } from "../../src/daemon/server.js";
import { createIngestHandler } from "../../src/daemon/routes/ingest.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { claudeProjectSlug, projectDbPath } from "../../src/daemon/project.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

// The sweep derives the Claude projects root from `homedir()`. Point it at a
// per-test fake home so the suite never touches the developer's real
// ~/.claude/projects; mkdtemp names carry only dashes, so give the fake home
// a path with a dot and an underscore — exactly the characters the old
// slash-only slug spelled differently.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.LCM_SCAN_FAKE_HOME ?? actual.homedir(),
  };
});

const paths = createLcmPaths(lcmHome());
const tempDirs: string[] = [];

beforeEach(() => {
  const fakeHome = [mkdtempSync(join(tmpdir(), "lcm-scan-home")), "with.dot_and_underscore"].join("/");
  process.env.LCM_SCAN_FAKE_HOME = fakeHome;
  tempDirs.push(fakeHome);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LCM_SCAN_FAKE_HOME;
});

/** Registers a project with stored memory and lays out one Claude transcript directory under its slug. */
function seedProject(cwd: string, slugDirName: string, sessionId: string): void {
  const fakeHome = process.env.LCM_SCAN_FAKE_HOME!;
  mkdirSync(cwd, { recursive: true });
  const projectEntry = join(paths.projectsDir, "entry");
  mkdirSync(projectEntry, { recursive: true });
  writeFileSync(join(projectEntry, "meta.json"), JSON.stringify({ cwd }));
  const claudeDir = join(fakeHome, ".claude", "projects", slugDirName);
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ message: { role: "user", content: "scan fixture Zephyrite transcript" } })}\n`,
  );
}

function storedMessages(cwd: string, sessionId: string): Array<{ content: string }> {
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    return db.prepare(
      `SELECT m.content FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.session_id = ?`,
    ).all(sessionId) as Array<{ content: string }>;
  } finally {
    db.close();
  }
}

describe("periodic transcript scan", () => {
  it("ingests a transcript found under the real project slug and not one under the old slash-only name", async () => {
    const project = join(process.env.LCM_SCAN_FAKE_HOME!, "proj.with_underscores");
    tempDirs.push(project);
    const config = loadDaemonConfig("/nonexistent");
    const ingest = createIngestHandler(config, paths);

    // The slug Claude Code actually creates: every non-alphanumeric character becomes "-".
    const realSlugDirName = claudeProjectSlug(project);
    // The older, wrong spelling this scan used to build: only slashes replaced.
    const oldSlugDirName = project.replace(/\//g, "-");
    expect(oldSlugDirName).not.toBe(realSlugDirName);

    seedProject(project, realSlugDirName, "scan-fixture-real");
    seedProject(project, oldSlugDirName, "scan-fixture-old");

    await scanForTranscripts(config, paths, ingest);

    const stored = storedMessages(project, "scan-fixture-real").map((row) => row.content);
    expect(stored).toContain("scan fixture Zephyrite transcript");
    // The directory the old convention created holds a transcript the fixed sweep never reads.
    expect(storedMessages(project, "scan-fixture-old")).toEqual([]);
  });

  it("is silent when a project has no Claude transcript directory", async () => {
    const project = join(process.env.LCM_SCAN_FAKE_HOME!, "quiet.project");
    tempDirs.push(project);
    const config = loadDaemonConfig("/nonexistent");
    const projectEntry = join(paths.projectsDir, "quiet");
    mkdirSync(projectEntry, { recursive: true });
    writeFileSync(join(projectEntry, "meta.json"), JSON.stringify({ cwd: project }));

    await expect(scanForTranscripts(config, paths, createIngestHandler(config, paths))).resolves.toBeUndefined();
    // Nothing was captured, so no project database was ever opened.
    expect(existsSync(projectDbPath(project, paths))).toBe(false);
  });
});
