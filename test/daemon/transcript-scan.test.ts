import { registerWorkerSession } from "../../src/worker-session.js";
import { projectId } from "../../src/daemon/project.js";
// test/daemon/transcript-scan.test.ts
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { scanForTranscripts } from "../../src/daemon/server.js";
import type { RouteHandler } from "../../src/daemon/server.js";
import { createIngestHandler } from "../../src/daemon/routes/ingest.js";
import { noopDaemonLog } from "../../src/daemon/log.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { claudeProjectSlug, projectDbPath, projectDir } from "../../src/daemon/project.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { parseTranscript } from "../../src/transcript.js";
import { TranscriptSourceError } from "../../src/transcript-source.js";
import { checkStalledSubagentCaptures } from "../../src/doctor/transcript-check.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import * as projectQueue from "../../src/daemon/project-queue.js";

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

// Only parseTranscript is wrapped, so one test can make a single subagent capture fail;
// every other transcript passes straight through to the real implementation.
vi.mock("../../src/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/transcript.js")>();
  return { ...actual, parseTranscript: vi.fn(actual.parseTranscript) };
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

  it("a real transcript scan racing enrollment cannot capture a worker canary", async () => {
    const cwd = join(process.env.LCM_SCAN_FAKE_HOME!, "worker-project");
    seedProject(cwd, claudeProjectSlug(cwd), "worker");
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "disabled" } }, {});
    const lease = await projectQueue.acquireProjectMutation(projectId(cwd));
    const registration = registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "hook" });
    const beganIngest = Promise.withResolvers<void>();
    const ingest = createIngestHandler(config, paths);
    const scan = scanForTranscripts(config, paths, async (...args) => {
      beganIngest.resolve();
      return ingest(...args);
    });
    try {
      await beganIngest.promise;
    } finally { lease.release(); }
    await registration; await scan;
    expect(storedMessages(cwd, "worker")).toEqual([]);
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      for (const table of ["messages_fts", "message_parts", "summaries", "promoted"]) expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
    } finally { db.close(); }
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

  it("yields to the event loop while walking many project directories", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const ingest = createIngestHandler(config, paths);

    // None of these can hold a transcript: no Claude project directory exists for
    // any of them. A scan that never yields walks all of them synchronously, in
    // one tick, so nothing else queued for that tick gets a turn before it ends.
    for (let i = 0; i < 120; i++) {
      const project = join(process.env.LCM_SCAN_FAKE_HOME!, `quiet-${i}`);
      const projectEntry = join(paths.projectsDir, `quiet-${i}`);
      mkdirSync(projectEntry, { recursive: true });
      writeFileSync(join(projectEntry, "meta.json"), JSON.stringify({ cwd: project }));
    }

    let timerFired = false;
    // Registered before the scan starts: a `setImmediate` callback only runs once
    // the current synchronous stretch of work ends. If the scan never yields, this
    // callback has to wait for the whole walk to finish before it can run at all,
    // and by then the scan's own promise has already settled — so awaiting it can
    // never observe `timerFired` as true. If the scan yields partway through (via
    // its own `setImmediate`-based yield), this callback — queued first — runs
    // ahead of the scan's continuation, and `timerFired` is true by the time the
    // scan's promise resolves.
    setImmediate(() => { timerFired = true; });

    await scanForTranscripts(config, paths, ingest);

    expect(timerFired).toBe(true);
  });
});

/** Registers a project with one transcript under its real slug; returns the paths a test needs to grow it. */
function seedFingerprintProject(name: string, content: string): { transcriptPath: string; sessionDir: string; project: string } {
  const fakeHome = process.env.LCM_SCAN_FAKE_HOME!;
  mkdirSync(join(fakeHome, "fp", name), { recursive: true });
  // `/ingest` resolves the cwd before it looks for subagent transcripts under that cwd's
  // slug, so the fixture lays the session out under the resolved path's slug too.
  const project = realpathSync(join(fakeHome, "fp", name));
  // The entry `/ingest` itself registers the project under, so the scan finds each session once.
  const projectEntry = projectDir(project, paths);
  mkdirSync(projectEntry, { recursive: true });
  writeFileSync(join(projectEntry, "meta.json"), JSON.stringify({ cwd: project }));
  const sessionsDir = join(fakeHome, ".claude", "projects", claudeProjectSlug(project));
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = `fp-session-${name}`;
  const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, content);
  return { transcriptPath, sessionDir: join(sessionsDir, sessionId), project };
}

const transcriptLine = (text: string): string => `${JSON.stringify({ message: { role: "user", content: text } })}\n`;

/** Wraps a route handler with a call counter, so a test can tell whether the scan actually invoked `/ingest` for a session, independent of what that ingest did to the database. */
function countingHandler(real: RouteHandler): { handler: RouteHandler; count: () => number } {
  let calls = 0;
  const handler: RouteHandler = async (req, res, body) => {
    calls++;
    await real(req, res, body);
  };
  return { handler, count: () => calls };
}

describe("periodic transcript scan: fingerprint dedup", () => {
  it("settles an unchanged subagent guard failure and retries when its transcript or sidecar changes", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const log = { ...noopDaemonLog, write: vi.fn() };
    const { handler, count } = countingHandler(createIngestHandler(config, paths, log));
    const { sessionDir, project } = seedFingerprintProject("subagent-guard", transcriptLine("parent"));
    const subagentDir = join(sessionDir, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const subagentPath = join(subagentDir, "agent-stalled.jsonl");
    const sidecarPath = join(subagentDir, "agent-stalled.meta.json");
    writeFileSync(subagentPath, transcriptLine("child"));
    const parse = vi.mocked(parseTranscript);
    const actual = parse.getMockImplementation()!;
    let childReads = 0;
    parse.mockImplementation((path: string) => {
      if (path.endsWith("/agent-stalled.jsonl")) {
        childReads++;
        throw new TranscriptSourceError("Claude transcript prefix differs from stored history");
      }
      return actual(path);
    });
    try {
      await scanForTranscripts(config, paths, handler);
      expect(count()).toBe(1);
      expect(childReads).toBe(1);
      expect(existsSync(join(projectDir(project, paths), "subagent-guard-failures.json"))).toBe(true);
      const stalled = checkStalledSubagentCaptures(paths);
      expect(stalled.status).toBe("warn");
      expect(stalled.message).toContain("agent-stalled");
      await scanForTranscripts(config, paths, handler);
      await scanForTranscripts(config, paths, handler);
      expect(count()).toBe(2);
      expect(childReads).toBe(1);
      expect(log.write.mock.calls.filter((call) => call[1] === "ingest.subagent_failed")).toHaveLength(1);

      writeFileSync(sidecarPath, JSON.stringify({ agentType: "worker" }));
      await scanForTranscripts(config, paths, handler);
      expect(count()).toBe(3);
      expect(childReads).toBe(2);
      await scanForTranscripts(config, paths, handler);
      await scanForTranscripts(config, paths, handler);
      expect(count()).toBe(4);
      expect(log.write.mock.calls.filter((call) => call[1] === "ingest.subagent_failed")).toHaveLength(2);

      appendFileSync(subagentPath, transcriptLine("changed"));
      expect(checkStalledSubagentCaptures(paths).status).toBe("pass");
      await scanForTranscripts(config, paths, handler);
      expect(count()).toBe(5);
      expect(childReads).toBe(3);
      expect(log.write.mock.calls.filter((call) => call[1] === "ingest.subagent_failed")).toHaveLength(3);

      parse.mockImplementation(actual);
      appendFileSync(subagentPath, transcriptLine("repaired"));
      await scanForTranscripts(config, paths, handler);
      await scanForTranscripts(config, paths, handler);
      expect(count()).toBe(6);
      expect(storedMessages(project, "agent-stalled").map((row) => row.content)).toContain("repaired");
      expect(checkStalledSubagentCaptures(paths).status).toBe("pass");
    } finally {
      parse.mockImplementation(actual);
    }
  });
  it("skips unchanged transcripts after the scan module is loaded afresh", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    seedFingerprintProject("restart-unchanged", transcriptLine("hello"));

    await scanForTranscripts(config, paths, handler);
    vi.mocked(parseTranscript).mockClear();
    vi.resetModules(); // a restarted daemon has no module-scoped fingerprint map
    const { scanForTranscripts: restartedScan } = await import("../../src/daemon/server.js");
    await restartedScan(config, paths, handler);

    expect(count()).toBe(1);
    expect(parseTranscript).not.toHaveBeenCalled();
  });

  it("re-reads a changed transcript after the scan module is loaded afresh", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { transcriptPath } = seedFingerprintProject("restart-changed", transcriptLine("first"));

    await scanForTranscripts(config, paths, handler);
    vi.resetModules();
    const { scanForTranscripts: restartedScan } = await import("../../src/daemon/server.js");
    appendFileSync(transcriptPath, transcriptLine("second"));
    await restartedScan(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("retries an incomplete ingest after the scan module is loaded afresh", async () => {
    const config = loadDaemonConfig("/nonexistent");
    seedFingerprintProject("restart-incomplete", transcriptLine("hello"));
    let calls = 0;
    const handler: RouteHandler = async (_req, res) => {
      calls++;
      res.writeHead(200);
      res.end(JSON.stringify({ incomplete: true }));
    };

    await scanForTranscripts(config, paths, handler);
    vi.resetModules();
    const { scanForTranscripts: restartedScan } = await import("../../src/daemon/server.js");
    await restartedScan(config, paths, handler);

    expect(calls).toBe(2);
  });

  it("re-ingests after a restart when the project database was replaced", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { project } = seedFingerprintProject("restart-db-replaced", transcriptLine("hello"));

    await scanForTranscripts(config, paths, handler);
    // A restore or recreate gives the database a new file identity; the recorded ingests no longer describe it.
    const dbPath = projectDbPath(project, paths);
    copyFileSync(dbPath, `${dbPath}.copy`);
    renameSync(`${dbPath}.copy`, dbPath);
    vi.resetModules();
    const { scanForTranscripts: restartedScan } = await import("../../src/daemon/server.js");
    await restartedScan(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("re-ingests after a restart on a different lcm version", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { project } = seedFingerprintProject("restart-upgraded", transcriptLine("hello"));

    await scanForTranscripts(config, paths, handler);
    // An upgrade: what a new version adds on ingest reaches unchanged transcripts only if they are read again.
    const sidecar = join(projectDir(project, paths), "scan-fingerprints.json");
    writeFileSync(sidecar, JSON.stringify({ ...JSON.parse(readFileSync(sidecar, "utf8")), version: "0.0.0-older" }));
    vi.resetModules();
    const { scanForTranscripts: restartedScan } = await import("../../src/daemon/server.js");
    await restartedScan(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("yields between transcripts in one project", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { transcriptPath } = seedFingerprintProject("many-sessions", transcriptLine("first"));
    writeFileSync(join(transcriptPath, "..", "another-session.jsonl"), transcriptLine("second"));
    const yieldSpy = vi.spyOn(projectQueue, "yieldToEventLoop");
    const yieldsAtIngest: number[] = [];
    const handler: RouteHandler = async (_req, res) => {
      yieldsAtIngest.push(yieldSpy.mock.calls.length);
      res.writeHead(200);
      res.end("{}");
    };

    try {
      await scanForTranscripts(config, paths, handler);
      expect(yieldsAtIngest).toHaveLength(2);
      expect(yieldsAtIngest[1]).toBeGreaterThan(yieldsAtIngest[0]);
    } finally {
      yieldSpy.mockRestore();
    }
  });

  it("ingests an unchanged transcript once across two passes", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    seedFingerprintProject("unchanged", transcriptLine("hello"));

    await scanForTranscripts(config, paths, handler);
    await scanForTranscripts(config, paths, handler);

    expect(count()).toBe(1);
  });

  it("re-ingests a session whose parent transcript was appended to between passes", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { transcriptPath } = seedFingerprintProject("appended", transcriptLine("first"));

    await scanForTranscripts(config, paths, handler);
    appendFileSync(transcriptPath, transcriptLine("second"));
    await scanForTranscripts(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("re-ingests a session whose parent is unchanged but a subagent transcript grew", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { sessionDir } = seedFingerprintProject("subagent-growth", transcriptLine("parent turn"));
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const subagentPath = join(subagentsDir, "agent-1.jsonl");
    writeFileSync(subagentPath, transcriptLine("subagent turn 1"));

    await scanForTranscripts(config, paths, handler);
    // The parent transcript itself is untouched; only the subagent transcript grows,
    // exactly the case a parent-only fingerprint would miss.
    appendFileSync(subagentPath, transcriptLine("subagent turn 2"));
    await scanForTranscripts(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("re-ingests a session whose subagent sidecar appeared after the subagent was captured", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { sessionDir } = seedFingerprintProject("sidecar-late", transcriptLine("parent turn"));
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-1.jsonl"), transcriptLine("subagent turn"));

    await scanForTranscripts(config, paths, handler);
    // Every transcript is untouched; only the attribution sidecar the next /ingest backfills from appears.
    writeFileSync(join(subagentsDir, "agent-1.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
    await scanForTranscripts(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("retries a session whose subagent capture failed although its parent ingest succeeded", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { sessionDir, project } = seedFingerprintProject("subagent-failure", transcriptLine("parent turn"));
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const subagentPath = join(subagentsDir, "agent-1.jsonl");
    writeFileSync(subagentPath, transcriptLine("subagent Obsidianite turn"));

    const parse = vi.mocked(parseTranscript);
    const real = parse.getMockImplementation()!;
    parse.mockImplementation((path) => {
      if (path === realpathSync(subagentPath)) throw new Error("simulated subagent parse failure");
      return real(path);
    });
    try {
      await scanForTranscripts(config, paths, handler);
    } finally {
      parse.mockImplementation(real);
    }
    await scanForTranscripts(config, paths, handler);
    await scanForTranscripts(config, paths, handler);

    // The failed pass recorded nothing; the next one captured the subagent and was recorded, so the third skipped.
    expect(count()).toBe(2);
    expect(storedMessages(project, "agent-1").map((row) => row.content))
      .toContain("subagent Obsidianite turn");
  });

  it("retries a session whose tool-call model backfill failed", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    const { project } = seedFingerprintProject("backfill-failure", transcriptLine("parent turn"));
    // A directory where the events database belongs: the backfill finds it, and opening it throws.
    const eventsPath = eventsDbPath(project, paths);
    mkdirSync(eventsPath, { recursive: true });
    tempDirs.push(eventsPath);

    await scanForTranscripts(config, paths, handler);
    await scanForTranscripts(config, paths, handler);

    expect(count()).toBe(2);
  });

  it("retries a session whose ingest failed on the previous pass", async () => {
    let calls = 0;
    const alwaysFails: RouteHandler = async () => {
      calls++;
      throw new Error("simulated ingest failure");
    };
    const config = loadDaemonConfig("/nonexistent");
    seedFingerprintProject("retry", transcriptLine("hello"));

    await scanForTranscripts(config, paths, alwaysFails);
    await scanForTranscripts(config, paths, alwaysFails);

    // Never having recorded a fingerprint for a failed attempt, the second pass tries again.
    expect(calls).toBe(2);
  });

  it("skips an unchanged guard failure and retries after the transcript changes", async () => {
    let calls = 0;
    const guardFailure: RouteHandler = async (_req, res) => {
      calls++;
      res.writeHead(400);
      res.end(JSON.stringify({ error: "transcript rejected" }));
    };
    const config = loadDaemonConfig("/nonexistent");
    const { transcriptPath } = seedFingerprintProject("guard-failure", transcriptLine("hello"));

    await scanForTranscripts(config, paths, guardFailure);
    await scanForTranscripts(config, paths, guardFailure);
    expect(calls).toBe(1);

    appendFileSync(transcriptPath, transcriptLine("changed"));
    await scanForTranscripts(config, paths, guardFailure);
    expect(calls).toBe(2);
  });

  it("retries a 500 even if its message resembles a prefix failure", async () => {
    let calls = 0;
    const failed: RouteHandler = async (_req, res) => {
      calls++;
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Claude transcript prefix differs from stored history" }));
    };
    const config = loadDaemonConfig("/nonexistent");
    seedFingerprintProject("other-failure", transcriptLine("hello"));

    await scanForTranscripts(config, paths, failed);
    await scanForTranscripts(config, paths, failed);
    expect(calls).toBe(2);
  });

  it("does not run a second pass while one is still in flight", async () => {
    const config = loadDaemonConfig("/nonexistent");
    const { handler, count } = countingHandler(createIngestHandler(config, paths));
    seedFingerprintProject("overlap", transcriptLine("hello"));

    // Called back to back, with no await between: the second call must see the first
    // pass's in-progress flag already set (a function call's synchronous prefix always
    // runs to completion before control returns to the caller) and return at once.
    const first = scanForTranscripts(config, paths, handler);
    const second = scanForTranscripts(config, paths, handler);
    await Promise.all([first, second]);

    expect(count()).toBe(1);
  });
});
