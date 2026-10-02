import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLcmConnection, closeLcmConnection, openStandaloneLcmConnection } from "../../../src/db/connection.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { invokeRoute } from "../../../src/daemon/routes/session-end.js";
import { SessionCapture } from "../../../src/capture.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { ScrubEngine } from "../../../src/scrub.js";

const dirs: string[] = [];
const writers: Worker[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(writers.splice(0).map(worker => worker.terminate()));
  closeLcmConnection();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-ingest-lock-"));
  dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "memory"));
  const dbPath = projectDbPath(cwd, paths);
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db, { claudeProjectsDir: cwd });
  const capture = new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths);
  await capture.write({ sessionId: "session", messages: [{ role: "user", content: "first", tokenCount: 1 }] });
  const handler = createIngestHandler(loadDaemonConfig("/nonexistent", {
    summarizer: { mock: true },
  }), paths);
  const ingest = () => invokeRoute<{ ingested: number }>(handler, {
    cwd, session_id: "session", messages: [
      { role: "user", content: "first", tokenCount: 1 },
      { role: "assistant", content: "second", tokenCount: 1 },
    ],
  });
  return { cwd, paths, dbPath, db, capture, ingest };
}

// SQLite is synchronous: the lock must be released on another thread, not by
// a timer on the thread blocked in the busy handler. The UPDATE is the event-time
// backfill's project write; the handshake fixes its order relative to capture.
async function backfillWriter(dbPath: string, holdMs: number, mode = "IMMEDIATE", completedMigration?: string) {
  const state = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(`
    const { workerData, parentPort } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const state = new Int32Array(workerData.state);
    const db = new DatabaseSync(workerData.dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    parentPort.postMessage("ready");
    Atomics.wait(state, 0, 0);
    db.exec("BEGIN " + workerData.mode);
    db.exec("UPDATE messages SET event_at = '2021-02-03T04:05:06.000Z', event_time_source = 'transcript' WHERE event_at IS NULL");
    if (workerData.completedMigration) db.exec("INSERT INTO " + workerData.completedMigration + " (id) VALUES (1)");
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
    Atomics.wait(state, 0, 1);
    Atomics.wait(state, 2, 0, workerData.holdMs);
    db.exec("COMMIT");
    db.close();
    Atomics.store(state, 1, 2);
    Atomics.notify(state, 1);
  `, { eval: true, workerData: { dbPath, holdMs, mode, completedMigration, state: state.buffer } });
  writers.push(worker);
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  return {
    lock() {
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      expect(Atomics.wait(state, 1, 0, 5000)).not.toBe("timed-out");
      expect(Atomics.load(state, 1)).toBe(1);
      const started = performance.now();
      Atomics.store(state, 0, 2);
      Atomics.notify(state, 0);
      return started;
    },
    commit() {
      Atomics.store(state, 2, 1);
      Atomics.notify(state, 2);
      while (Atomics.load(state, 1) === 1) {
        expect(Atomics.wait(state, 1, 1, 5000)).not.toBe("timed-out");
      }
      expect(Atomics.load(state, 1)).toBe(2);
    },
  };
}

describe("POST /ingest with a concurrent project backfill", () => {
  it("installs the busy timeout before initializing WAL on a locked project", async () => {
    const { db, dbPath } = await fixture();
    db.exec("PRAGMA journal_mode = DELETE");
    closeLcmConnection(dbPath);
    const writer = await backfillWriter(dbPath, 200, "EXCLUSIVE");
    const started = writer.lock();
    const reopened = openStandaloneLcmConnection(dbPath);
    try {
      expect(performance.now() - started).toBeGreaterThanOrEqual(150);
      expect(reopened.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
      expect(reopened.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    } finally { reopened.close(); }
  });

  it("waits for a brief write lock on an already migrated project", async () => {
    const { dbPath, ingest, capture } = await fixture();
    const writer = await backfillWriter(dbPath, 200);
    const started = writer.lock();
    expect(await ingest()).toMatchObject({ ingested: 1 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.content))
      .toEqual(["first", "second"]);
  });

  it("retains the database-is-locked error after the write timeout", async () => {
    const { db, dbPath, ingest, capture } = await fixture();
    db.exec("PRAGMA busy_timeout = 100");
    const writer = await backfillWriter(dbPath, 5000);
    const started = writer.lock();
    await expect(ingest()).rejects.toThrow('HTTP 500: {"error":"database is locked"}');
    expect(performance.now() - started).toBeGreaterThanOrEqual(80);
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.content))
      .toEqual(["first"]);
  });

  it.each(["promoted_tags_backfill", "passive_intent_repair"])("accepts %s completed by another connection while waiting", async migration => {
    const { db, dbPath, ingest } = await fixture();
    db.exec(`DELETE FROM ${migration}`);
    const writer = await backfillWriter(dbPath, 200, "IMMEDIATE", migration);
    const exec = db.exec.bind(db);
    let locked = false;
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (!locked && sql === "BEGIN IMMEDIATE") {
        locked = true;
        writer.lock();
      }
      exec(sql);
    });
    expect(await ingest()).toMatchObject({ ingested: 1 });
  });

  it.each([
    ["promoted_tags_backfill", false], ["passive_intent_repair", false],
    ["promoted_tags_backfill", true], ["passive_intent_repair", true],
  ] as const)("waits for pending %s (backfill commits after the read: %s)", async (migration, commitAfterRead) => {
    const { db, dbPath, ingest, capture } = await fixture();
    db.exec(`DELETE FROM ${migration}`);
    const writer = await backfillWriter(dbPath, 200);
    const exec = db.exec.bind(db);
    let locked = false;
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (!locked && (sql === `SAVEPOINT ${migration}` || sql === "BEGIN IMMEDIATE")) {
        locked = true;
        writer.lock();
      }
      exec(sql);
    });
    if (commitAfterRead) {
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        if (/^SELECT rowid, .*FROM promoted/.test(sql)) {
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...args) {
            // Exhausting even an empty SELECT establishes the deferred snapshot.
            // Commit the other connection before the migration's first write.
            yield* iterate(...args);
            writer.commit();
          };
        }
        return statement;
      });
    }
    const started = performance.now();
    expect(await ingest()).toMatchObject({ ingested: 1 });
    expect(locked).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.content))
      .toEqual(["first", "second"]);
  });
});
