import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCapture } from "../../../src/capture.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { noopDaemonLog, type DaemonLog } from "../../../src/daemon/log.js";
import { claudeTranscriptPath, projectDbPath, projectDir, projectId } from "../../../src/daemon/project.js";
import { enqueue } from "../../../src/daemon/project-queue.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { rememberSubagentGuard, subagentGuardFingerprint } from "../../../src/daemon/subagent-guard-failures.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());
const tempDirs: string[] = [];
const SUBAGENT = "agent-sub1";

/** Writes transcript entries as Claude Code does, one JSON object per line. */
function writeTranscript(path: string, entries: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

const message = (role: string, text: string) => ({ type: "message", message: { role, content: text } });

const TIMING_FIELDS = ["queue_ms", "main_ms", "discover_ms", "subagent_ms", "total_ms"];
const COUNT_FIELDS = [
  "subagents_total", "subagents_skipped", "subagents_guard_skipped", "subagents_captured", "subagents_failed", "subagents_precheck_errors",
];

/** One subagent's `ingest.timing` counts: everything zero but its total and `overrides`. */
function counts(overrides: Record<string, number>): Record<string, number> {
  return { ...Object.fromEntries(COUNT_FIELDS.map((field) => [field, 0])), subagents_total: 1, ...overrides };
}

describe("POST /ingest skips a subagent transcript whose capture would be a no-op", () => {
  let daemon: DaemonInstance | undefined;
  let cwd: string;
  const log = { ...noopDaemonLog, write: vi.fn<DaemonLog["write"]>() };
  const realCaptureTranscript = SessionCapture.prototype.captureTranscript;
  const captureTranscript = vi.spyOn(SessionCapture.prototype, "captureTranscript");

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    vi.unstubAllEnvs();
    log.write.mockClear();
    // Back to the real capture after a test that replaced it.
    captureTranscript.mockReset();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setUp(): { sessionId: string; parentTranscriptPath: string; subagentPath: string } {
    const home = mkdtempSync(join(tmpdir(), "lossless-subagent-skip-home-"));
    tempDirs.push(home);
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "lossless-subagent-skip-cwd-")));
    tempDirs.push(cwd);
    vi.stubEnv("HOME", home);
    // os.homedir() reads USERPROFILE on Windows: without it the transcripts would land in the real ~/.claude.
    vi.stubEnv("USERPROFILE", home);
    const sessionId = "parent-session";
    const parentTranscriptPath = claudeTranscriptPath(cwd, sessionId);
    if (!parentTranscriptPath) throw new Error("no transcript path for the parent session");
    writeTranscript(parentTranscriptPath, [message("user", "hi"), message("assistant", "hello")]);
    // The path discovery builds, so a recorded guard failure is keyed by the same string.
    const subagentPath = join(dirname(parentTranscriptPath), sessionId, "subagents", `${SUBAGENT}.jsonl`);
    writeTranscript(subagentPath, [message("user", "do the task"), message("assistant", "done")]);
    return { sessionId, parentTranscriptPath, subagentPath };
  }

  async function start(create: typeof createDaemon = createDaemon): Promise<void> {
    daemon = await create(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }), { log });
  }

  async function post(body: Record<string, unknown>): Promise<Response> {
    if (!daemon) throw new Error("daemon not started");
    return fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  /** One parent ingest, as the hook sends it; afterwards only this ingest's records and captures are counted. */
  async function ingest(sessionId: string): Promise<unknown> {
    log.write.mockClear();
    captureTranscript.mockClear();
    const response = await post({ session_id: sessionId, cwd });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  function timing(): Record<string, unknown> {
    const records = log.write.mock.calls.filter(([, event]) => event === "ingest.timing");
    expect(records).toHaveLength(1);
    return records[0][2] ?? {};
  }

  function subagentCaptures(): number {
    return captureTranscript.mock.calls.filter(([input]) => input.sessionId === SUBAGENT).length;
  }

  function withDb<T>(use: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      return use(db);
    } finally {
      db.close();
    }
  }

  function subagentContents(): unknown[] {
    return withDb((db) => db.prepare(`SELECT content FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE c.session_id = ? ORDER BY seq`).all(SUBAGENT).map((row) => row.content));
  }

  function prefixFingerprint(): unknown {
    return withDb((db) => db.prepare(`SELECT prefix_fingerprint FROM codex_ingest_cursors WHERE conversation_id =
      (SELECT conversation_id FROM conversations WHERE session_id = ?)`).get(SUBAGENT)?.prefix_fingerprint);
  }

  /** The transcript paths the project's guard-failure sidecar lists. */
  function recordedPaths(): string[] {
    const failuresPath = join(projectDir(cwd, paths), "subagent-guard-failures.json");
    return existsSync(failuresPath)
      ? Object.keys((JSON.parse(readFileSync(failuresPath, "utf8")) as { failures: Record<string, unknown> }).failures) : [];
  }

  it("skips an unchanged subagent on the next parent ingest without capturing it, and replies as before", async () => {
    const { sessionId, subagentPath } = setUp();
    writeFileSync(subagentPath.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose" }));
    await start();
    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));

    expect(await ingest(sessionId)).toEqual({ ingested: 0, totalTokens: 0 });
    expect(subagentCaptures()).toBe(0);
    expect(timing()).toMatchObject(counts({ subagents_skipped: 1 }));
    expect(subagentContents()).toEqual(["do the task", "done"]);
  });

  it("captures a subagent transcript that grew since its cursor", async () => {
    const { sessionId, subagentPath } = setUp();
    await start();
    await ingest(sessionId);
    appendFileSync(subagentPath, JSON.stringify(message("user", "one more thing")) + "\n");

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));
    expect(subagentContents()).toEqual(["do the task", "done", "one more thing"]);
  });

  it("does not skip a same-size in-place rewrite of the consumed bytes", async () => {
    const { sessionId, subagentPath } = setUp();
    await start();
    await ingest(sessionId);
    const before = statSync(subagentPath, { bigint: true });
    writeTranscript(subagentPath, [message("user", "do the tusk"), message("assistant", "done")]);
    const after = statSync(subagentPath, { bigint: true });
    // Same file, same end: only the prefix fingerprint tells the rewrite apart.
    expect([after.size, after.dev, after.ino]).toEqual([before.size, before.dev, before.ino]);

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject({ subagents_skipped: 0, subagents_precheck_errors: 0 });
  });

  it("does not skip once a stored message change has withdrawn the cursor's proof, and skips again after the capture re-proves it", async () => {
    const { sessionId } = setUp();
    await start();
    await ingest(sessionId);
    expect(prefixFingerprint()).toEqual(expect.any(String));
    withDb((db) => {
      const first = `conversation_id = (SELECT conversation_id FROM conversations WHERE session_id = '${SUBAGENT}') AND seq = 0`;
      db.exec(`UPDATE messages SET content = content || '!' WHERE ${first}`);
      db.exec(`UPDATE messages SET content = substr(content, 1, length(content) - 1) WHERE ${first}`);
    });
    expect(prefixFingerprint()).toBeNull();

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));
    expect(prefixFingerprint()).toEqual(expect.any(String));

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(0);
    expect(timing()).toMatchObject(counts({ subagents_skipped: 1 }));
  });

  it("does not skip after the redaction rules changed", async () => {
    const { sessionId } = setUp();
    await start();
    await ingest(sessionId);
    mkdirSync(projectDir(cwd, paths), { recursive: true });
    writeFileSync(join(projectDir(cwd, paths), "sensitive-patterns.txt"), "never-matching-pattern-zq\n");

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));

    await ingest(sessionId);
    expect(timing()).toMatchObject(counts({ subagents_skipped: 1 }));
  });

  it("does not skip when the session stores a different count than its cursor accounts for", async () => {
    const { sessionId } = setUp();
    await start();
    await ingest(sessionId);
    // A plain insert fires no cursor trigger, and a legacy cursor without a validated count has no
    // pending overlap: only the stored count disagrees with the cursor.
    withDb((db) => {
      db.prepare(`INSERT INTO messages (conversation_id, seq, role, content, token_count)
        SELECT conversation_id, 2, 'user', 'written by another route', 1 FROM conversations WHERE session_id = ?`).run(SUBAGENT);
      db.prepare(`UPDATE codex_ingest_cursors SET claude_validated_count = NULL
        WHERE conversation_id = (SELECT conversation_id FROM conversations WHERE session_id = ?)`).run(SUBAGENT);
    });
    expect(prefixFingerprint()).toEqual(expect.any(String));

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject({ subagents_skipped: 0, subagents_precheck_errors: 0 });
  });

  it("does not skip while an enrollment's stored overlap is still to be compared", async () => {
    const { sessionId } = setUp();
    await start();
    await ingest(sessionId);
    withDb((db) => db.prepare(`UPDATE codex_ingest_cursors SET claude_validated_count = 1
      WHERE conversation_id = (SELECT conversation_id FROM conversations WHERE session_id = ?)`).run(SUBAGENT));

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));

    await ingest(sessionId);
    expect(timing()).toMatchObject(counts({ subagents_skipped: 1 }));
  });

  it("does not skip a subagent whose sidecar appeared with a parent until that attribution is stored", async () => {
    const { sessionId, subagentPath } = setUp();
    await start();
    await ingest(sessionId);
    // A sidecar-less transcript has no attribution to backfill.
    await ingest(sessionId);
    expect(timing()).toMatchObject(counts({ subagents_skipped: 1 }));

    writeFileSync(subagentPath.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose" }));
    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));
    expect(withDb((db) => db.prepare("SELECT parent_session_id, subagent_type FROM conversations WHERE session_id = ?").get(SUBAGENT)))
      .toEqual({ parent_session_id: sessionId, subagent_type: "general-purpose" });

    await ingest(sessionId);
    expect(timing()).toMatchObject(counts({ subagents_skipped: 1 }));
  });

  it("skips nothing while any summarize_workers row exists", async () => {
    const { sessionId } = setUp();
    await start();
    await ingest(sessionId);
    withDb((db) => db.prepare("INSERT INTO summarize_workers (session_id, cwd, client, state) VALUES ('unrelated-worker', ?, 'claude', 'abandoned')")
      .run(cwd));

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));
    expect(subagentContents()).toEqual(["do the task", "done"]);
  });

  it("skips nothing once the session folder resolves elsewhere, so the capture still vets the path", async () => {
    const { sessionId, parentTranscriptPath } = setUp();
    await start();
    await ingest(sessionId);
    // Moved off the allowed roots and linked back: discovery lists the same paths, but each resolves outside.
    const sessionDir = join(dirname(parentTranscriptPath), sessionId);
    const elsewhere = mkdtempSync(join(tmpdir(), "lossless-subagent-skip-moved-"));
    tempDirs.push(elsewhere);
    renameSync(sessionDir, join(elsewhere, sessionId));
    symlinkSync(join(elsewhere, sessionId), sessionDir, "junction");

    expect(await ingest(sessionId)).toMatchObject({ incomplete: true });
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_failed: 1 }));
  });

  it("keeps a subagent with a recorded guard failure on the capture path, which clears the failure", async () => {
    const { sessionId, subagentPath } = setUp();
    await start();
    await ingest(sessionId);
    // A fingerprint the transcript no longer has: the unchanged-file guard does not skip it.
    rememberSubagentGuard(cwd, paths, subagentPath, "stale-fingerprint", SUBAGENT, sessionId, "simulated failure");
    expect(recordedPaths()).toEqual([subagentPath]);

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));
    expect(recordedPaths()).toEqual([]);
  });

  it("keeps the capture path for a failure only the sidecar still holds after a daemon restart", async () => {
    const { sessionId, subagentPath } = setUp();
    await start();
    await ingest(sessionId);
    rememberSubagentGuard(cwd, paths, subagentPath, "stale-fingerprint", SUBAGENT, sessionId, "simulated failure");
    await daemon?.stop();
    daemon = undefined;
    vi.resetModules(); // a restarted daemon has no module-scoped failure map
    const { createDaemon: restartedDaemon } = await import("../../../src/daemon/server.js");
    await start(restartedDaemon);

    await ingest(sessionId);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1 }));
    expect(recordedPaths()).toEqual([]);
  });

  it("counts a subagent the unchanged-failure guard skips, before any caught-up check", async () => {
    const { sessionId, subagentPath } = setUp();
    await start();
    await ingest(sessionId);
    rememberSubagentGuard(cwd, paths, subagentPath, subagentGuardFingerprint(subagentPath), SUBAGENT, sessionId, "simulated failure");

    await ingest(sessionId);
    expect(subagentCaptures()).toBe(0);
    expect(timing()).toMatchObject(counts({ subagents_guard_skipped: 1 }));
  });

  it("counts a subagent whose capture failed, and answers incomplete", async () => {
    const { sessionId } = setUp();
    captureTranscript.mockImplementation(async function (this: SessionCapture, input) {
      if (input.sessionId === SUBAGENT) throw new Error("simulated capture failure");
      return realCaptureTranscript.call(this, input);
    });
    await start();

    expect(await ingest(sessionId)).toMatchObject({ incomplete: true });
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_failed: 1 }));
  });

  it("reports the time each phase took, waiting for the project included", async () => {
    const { sessionId } = setUp();
    const HELD_MS = 40;
    const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, HELD_MS));
    captureTranscript.mockImplementation(async function (this: SessionCapture, input) {
      // The parent's capture runs in the project queue; the subagent pass queues behind this.
      if (input.sessionId === sessionId) void enqueue(projectId(cwd), sleep);
      await sleep();
      return realCaptureTranscript.call(this, input);
    });
    await start();

    await ingest(sessionId);
    const record = timing();
    for (const field of TIMING_FIELDS) expect(Number.isFinite(record[field]), field).toBe(true);
    const [queued, main, subagent, total] = ["queue_ms", "main_ms", "subagent_ms", "total_ms"].map((field) => Number(record[field]));
    // Lower bounds only: a slow machine makes every phase longer, never shorter.
    expect(main).toBeGreaterThanOrEqual(HELD_MS - 5);
    expect(subagent).toBeGreaterThanOrEqual(HELD_MS - 5);
    expect(queued).toBeGreaterThanOrEqual(HELD_MS / 2);
    expect(total).toBeGreaterThanOrEqual(queued + main + subagent - 3);
  });

  it("writes ingest.timing with numbers and ids only, on success and when the ingest fails", async () => {
    const { sessionId, parentTranscriptPath } = setUp();
    await start();
    await ingest(sessionId);
    const success = timing();
    // A failed caught-up check falls back to the capture and is counted.
    const check = vi.spyOn(SessionCapture.prototype, "transcriptCaughtUp").mockRejectedValueOnce(new Error("simulated check failure"));
    await ingest(sessionId);
    check.mockRestore();
    expect(subagentCaptures()).toBe(1);
    expect(timing()).toMatchObject(counts({ subagents_captured: 1, subagents_precheck_errors: 1 }));

    expect(Object.keys(success).sort()).toEqual(["cwd", "session_id", "client", ...TIMING_FIELDS, ...COUNT_FIELDS].sort());
    expect(success).toMatchObject({ cwd, session_id: sessionId, client: "claude", ...counts({ subagents_captured: 1 }) });
    for (const field of TIMING_FIELDS) expect(success[field], field).toEqual(expect.any(Number));

    withDb((db) => db.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'refused'); END"));
    appendFileSync(parentTranscriptPath, JSON.stringify(message("user", "lost")) + "\n");
    log.write.mockClear();
    expect((await post({ session_id: sessionId, cwd })).status).toBe(500);
    const failure = timing();
    expect(failure).toMatchObject({ cwd, session_id: sessionId, client: "claude", ...counts({ subagents_total: 0 }) });
    for (const field of TIMING_FIELDS) expect(failure[field], field).toEqual(expect.any(Number));
    expect(log.write.mock.calls.map(([, event]) => event)).toContain("ingest.failed");
  });
});
