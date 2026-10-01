import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { SessionCapture } from "../../../src/capture.js";
import { ScrubEngine } from "../../../src/scrub.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { checkStalledSubagentCaptures } from "../../../src/doctor/transcript-check.js";

const paths = createLcmPaths(lcmHome());

interface CursorRow {
  byte_offset: number;
  message_count: number;
  record_boundary: number;
}

interface StoredState {
  cursor: CursorRow;
  messages: Array<{ role: string; content: string }>;
}

const tempDirs: string[] = [];
const projectDirs: string[] = [];

function messageLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

function createTranscript(
  records: string[],
  options: { trailingNewline?: boolean } = {},
): { cwd: string; path: string; sessionId: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lossless-codex-cursor-"));
  const sessionId = `cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const path = join(cwd, "rollout.jsonl");
  const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } });
  const trailingNewline = options.trailingNewline ?? true;
  writeFileSync(path, [meta, ...records].join("\n") + (trailingNewline ? "\n" : ""));
  tempDirs.push(cwd);
  projectDirs.push(dirname(projectDbPath(cwd, paths)));
  return { cwd, path, sessionId };
}

function readState(cwd: string, sessionId: string): StoredState {
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    const cursor = db.prepare(`
      SELECT ci.byte_offset, ci.message_count, ci.record_boundary
      FROM codex_ingest_cursors ci
      JOIN conversations c ON c.conversation_id = ci.conversation_id
      WHERE c.session_id = ?
    `).get(sessionId) as CursorRow | undefined;
    if (!cursor) throw new Error(`missing cursor for ${sessionId}`);
    const messages = db.prepare(`
      SELECT m.role, m.content
      FROM messages m
      JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE c.session_id = ?
      ORDER BY m.seq
    `).all(sessionId) as unknown as StoredState["messages"];
    return { cursor, messages };
  } finally {
    db.close();
  }
}

describe("Codex persistent ingest cursor", () => {
  let daemon: DaemonInstance | undefined;

  const startDaemon = async (): Promise<void> => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
  };

  const post = async (
    fixture: { cwd: string; path: string; sessionId: string },
    source: "live" | "import" = "live",
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!daemon) throw new Error("daemon is not running");
    const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: "codex",
        session_id: fixture.sessionId,
        cwd: fixture.cwd,
        transcript_path: fixture.path,
        source,
      }),
    });
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  };

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const path of projectDirs.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
    for (const path of tempDirs.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("stores the complete file byte offset and leaves it unchanged for an unchanged file", async () => {
    const fixture = createTranscript([messageLine("user", "first")]);
    await startDaemon();

    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    const first = readState(fixture.cwd, fixture.sessionId);
    expect(first.cursor).toEqual({
      byte_offset: statSync(fixture.path).size,
      message_count: 1,
      record_boundary: 1,
    });

    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 0 } });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(first);
  });

  it.each(["root", "subagent"])("records an unprovable paginated %s once and skips later reads, growth and restarts", async (kind) => {
    const fixture = createTranscript([messageLine("user", "one"), messageLine("assistant", "two")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    const originalTimes = statSync(fixture.path);
    const meta = JSON.stringify({ type: "session_meta", payload: {
      id: fixture.sessionId, cwd: fixture.cwd, history_mode: "paginated",
      ...(kind === "subagent" ? { forked_from_id: "parent", subagent_history_start_ordinal: 2 } : {}),
    } });
    const compacted = JSON.stringify({ type: "compacted", payload: { window_number: 1, previous_window_id: "window-0" } });
    writeFileSync(fixture.path, `${meta}\n${compacted}\n${messageLine("user", kind === "root" ? "one" : "different")}\n`);
    utimesSync(fixture.path, originalTimes.atime, originalTimes.mtime);
    expect(await post(fixture)).toMatchObject({ status: 400 });
    const guardPath = join(dirname(projectDbPath(fixture.cwd, paths)), "subagent-guard-failures.json");
    const recorded = readFileSync(guardPath, "utf8");
    expect(checkStalledSubagentCaptures(paths)).toMatchObject({ status: "warn" });
    expect(checkStalledSubagentCaptures(paths).message).toContain(fixture.sessionId);
    expect(checkStalledSubagentCaptures(paths).message).toContain("Codex capture");
    expect(checkStalledSubagentCaptures(paths).message).toContain("lcm capture-retry --session <id>");
    // An invalid file would fail parsing if capture retried it.
    appendFileSync(fixture.path, "not JSON\n");
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 0, blocked: true } });
    await daemon!.stop();
    daemon = undefined;
    await startDaemon();
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 0, blocked: true } });
    expect(readFileSync(guardPath, "utf8")).toBe(recorded);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);
    expect(checkStalledSubagentCaptures(paths).message).toContain(fixture.sessionId);
  });

  it.each(["restored", "mismatch"])("retries legacy rule guards and handles a %s transcript", async (outcome) => {
    const fixture = createTranscript([messageLine("user", "one"), messageLine("assistant", "two")]);
    const dbPath = projectDbPath(fixture.cwd, paths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      runLcmMigrations(db);
      await new SessionCapture(db, "fixture", new ScrubEngine([], [])).captureTranscript({
        client: "codex", sessionId: fixture.sessionId, cwd: fixture.cwd, transcriptPath: fixture.path,
      });
    } finally { db.close(); }
    const before = readState(fixture.cwd, fixture.sessionId);
    const guardPath = join(dirname(dbPath), "subagent-guard-failures.json");
    const identity = statSync(dbPath);
    writeFileSync(guardPath, JSON.stringify({ db: `${identity.dev}:${identity.ino}`, version: "older", failures: {
      [fixture.path]: { db: `${identity.dev}:${identity.ino}`, fingerprint: "", sessionId: fixture.sessionId,
        message: "old rule rejected", client: "codex", terminal: true },
    } }));
    if (outcome === "mismatch") {
      const meta = JSON.stringify({ type: "session_meta", payload: {
        id: fixture.sessionId, cwd: fixture.cwd, history_mode: "paginated",
      } });
      writeFileSync(fixture.path, `${meta}\n${messageLine("user", "different")}\n`);
    } else appendFileSync(fixture.path, `${messageLine("assistant", "restored")}\n`);
    await startDaemon();
    expect(await post(fixture)).toMatchObject(outcome === "restored"
      ? { status: 200, body: { ingested: 1 } } : { status: 400 });
    const record = readFileSync(guardPath, "utf8");
    expect(Object.keys(JSON.parse(record).failures)).toHaveLength(outcome === "restored" ? 0 : 1);
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 0,
      ...(outcome === "mismatch" ? { blocked: true } : {}),
    } });
    expect(readFileSync(guardPath, "utf8")).toBe(record);
    expect(readState(fixture.cwd, fixture.sessionId).messages).toEqual(outcome === "restored"
      ? [...before.messages, { role: "assistant", content: "restored" }] : before.messages);
  });

  it.each(["session", "all"])("clears %s guards, rechecks alignment and records a persistent mismatch once", async (scope) => {
    const fixture = createTranscript([messageLine("user", "one"), messageLine("assistant", "two")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    const original = readFileSync(fixture.path, "utf8");
    const meta = JSON.stringify({ type: "session_meta", payload: {
      id: fixture.sessionId, cwd: fixture.cwd, history_mode: "paginated",
    } });
    writeFileSync(fixture.path, `${meta}\n${messageLine("user", "different")}\n`);
    expect((await post(fixture)).status).toBe(400);
    const guardPath = join(dirname(projectDbPath(fixture.cwd, paths)), "subagent-guard-failures.json");
    const clear = async () => {
      const response = await fetch(`http://127.0.0.1:${daemon!.address().port}/capture-retry`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: fixture.cwd, ...(scope === "all" ? { all: true } : { session_id: fixture.sessionId }) }),
      });
      return { status: response.status, body: await response.json() };
    };
    expect(await clear()).toMatchObject({ status: 200, body: { cleared: 1 } });
    expect(checkStalledSubagentCaptures(paths).status).toBe("pass");
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);
    expect((await post(fixture)).status).toBe(400);
    const rerecorded = readFileSync(guardPath, "utf8");
    expect(await post(fixture)).toMatchObject({ status: 200, body: { blocked: true } });
    expect(readFileSync(guardPath, "utf8")).toBe(rerecorded);
    expect(Object.keys(JSON.parse(rerecorded).failures)).toHaveLength(1);

    writeFileSync(fixture.path, `${original}${messageLine("assistant", "restored")}\n`);
    expect(await clear()).toMatchObject({ status: 200, body: { cleared: 1 } });
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId).messages).toEqual([...before.messages, { role: "assistant", content: "restored" }]);
    expect(await clear()).toMatchObject({ status: 200, body: { cleared: 0 } });
  });

  it("persists a proven paginated re-anchor without changing stored rows, then resumes after restart", async () => {
    const fixture = createTranscript([messageLine("user", "inherited"), messageLine("assistant", "own")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    const meta = JSON.stringify({ type: "session_meta", payload: {
      id: fixture.sessionId, cwd: fixture.cwd, history_mode: "paginated", forked_from_id: "parent",
      subagent_history_start_ordinal: 2,
    } });
    const compacted = JSON.stringify({ type: "compacted", payload: { window_number: 1, previous_window_id: "window-0" } });
    writeFileSync(fixture.path, `${meta}\n${compacted}\n${messageLine("assistant", "own")}\n`);
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 0 } });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual({
      cursor: { byte_offset: statSync(fixture.path).size, message_count: 2, record_boundary: 1 },
      messages: before.messages,
    });
    await daemon!.stop();
    daemon = undefined;
    await startDaemon();
    appendFileSync(fixture.path, `${compacted}\n${messageLine("user", "later")}\n`);
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId).messages).toEqual([...before.messages, { role: "user", content: "later" }]);
    expect(readState(fixture.cwd, fixture.sessionId).cursor.message_count).toBe(3);
  });

  it("does not advance past a partial UTF-8 record, then ingests it when completed", async () => {
    const fixture = createTranscript([messageLine("user", "first")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);

    const tail = Buffer.from(`${messageLine("assistant", "after café")}\n`, "utf8");
    const accented = tail.indexOf(Buffer.from("é", "utf8"));
    expect(accented).toBeGreaterThan(0);
    appendFileSync(fixture.path, tail.subarray(0, accented + 1));

    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 0 } });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);

    appendFileSync(fixture.path, tail.subarray(accented + 1));
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual({
      cursor: {
        byte_offset: statSync(fixture.path).size,
        message_count: 2,
        record_boundary: 1,
      },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "after café" },
      ],
    });
  });

  it("upgrades legacy cursors without fingerprints through a verified recovery scan", async () => {
    const fixture = createTranscript([messageLine("user", "legacy history")]);
    await startDaemon();
    await post(fixture);
    await daemon!.stop();
    daemon = undefined;
    const db = new DatabaseSync(projectDbPath(fixture.cwd, paths));
    try {
      db.exec("ALTER TABLE codex_ingest_cursors DROP COLUMN prefix_fingerprint");
    } finally {
      db.close();
    }
    appendFileSync(fixture.path, `${messageLine("assistant", "after upgrade")}\n`);
    await startDaemon();
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId).messages.map(message => message.content))
      .toEqual(["legacy history", "after upgrade"]);
  });

  it("continues from the persisted cursor after a daemon restart", async () => {
    const fixture = createTranscript([messageLine("user", "before restart")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);

    await daemon!.stop();
    daemon = undefined;
    appendFileSync(fixture.path, `${messageLine("assistant", "after restart")}\n`);
    await startDaemon();

    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    const after = readState(fixture.cwd, fixture.sessionId);
    expect(after.cursor.byte_offset).toBe(statSync(fixture.path).size);
    expect(after.cursor.byte_offset).toBeGreaterThan(before.cursor.byte_offset);
    expect(after.cursor.message_count).toBe(2);
    expect(after.messages.map(message => message.content)).toEqual(["before restart", "after restart"]);
  });

  it("rejects equal-size in-place rewrites without mixing session histories", async () => {
    const fixture = createTranscript([messageLine("user", "alpha"), messageLine("assistant", "bravo")]);
    const original = readFileSync(fixture.path, "utf8");
    const originalStat = statSync(fixture.path);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);

    writeFileSync(fixture.path, original.replace("alpha", "delta").replace("bravo", "eagle"));
    expect(statSync(fixture.path).ino).toBe(originalStat.ino);
    expect(statSync(fixture.path).size).toBe(originalStat.size);
    expect(await post(fixture)).toMatchObject({ status: 400 });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);

    const tail = `${messageLine("user", "new tail")}\n`;
    appendFileSync(fixture.path, tail);
    expect(await post(fixture)).toMatchObject({ status: 400 });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);

    writeFileSync(fixture.path, original + tail);
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId).messages.map(message => message.content))
      .toEqual(["alpha", "bravo", "new tail"]);
  });

  it("serializes concurrent captures of the same appended tail", async () => {
    const fixture = createTranscript([messageLine("user", "first")]);
    await startDaemon();
    await post(fixture);
    appendFileSync(fixture.path, `${messageLine("assistant", "one shared tail")}\n`);

    const captures = await Promise.all([post(fixture), post(fixture)]);

    expect(captures.map(result => result.body.ingested).sort()).toEqual([0, 1]);
    const state = readState(fixture.cwd, fixture.sessionId);
    expect(state.cursor.message_count).toBe(2);
    expect(state.messages.map(message => message.content)).toEqual(["first", "one shared tail"]);
  });

  it("hands an import-only final record to later live ingestion without duplicating it", async () => {
    const fixture = createTranscript(
      [messageLine("user", "imported final record")],
      { trailingNewline: false },
    );
    await startDaemon();

    expect(await post(fixture, "import")).toMatchObject({ status: 200, body: { ingested: 1 } });
    const imported = readState(fixture.cwd, fixture.sessionId);
    expect(imported.cursor.byte_offset).toBe(statSync(fixture.path).size);
    expect(imported.cursor.record_boundary).toBe(0);

    appendFileSync(fixture.path, `\n${messageLine("assistant", "new live record")}\n`);
    expect(await post(fixture, "live")).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual({
      cursor: {
        byte_offset: statSync(fixture.path).size,
        message_count: 2,
        record_boundary: 1,
      },
      messages: [
        { role: "user", content: "imported final record" },
        { role: "assistant", content: "new live record" },
      ],
    });
  });

  it("rejects malformed UTF-8 without advancing the cursor or corrupting stored text", async () => {
    const fixture = createTranscript([messageLine("user", "before invalid encoding")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    const tail = Buffer.from(`${messageLine("assistant", "x")}\n`, "utf8");
    const contentByte = tail.indexOf(Buffer.from('"x"')) + 1;
    expect(contentByte).toBeGreaterThan(0);
    tail[contentByte] = 0xc3;
    appendFileSync(fixture.path, tail);

    const result = await post(fixture);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(`Invalid Codex transcript UTF-8 at byte offset ${before.cursor.byte_offset}`);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);
  });

  it("keeps messages and cursor unchanged for a malformed completed suffix", async () => {
    const fixture = createTranscript([messageLine("user", "before malformed tail")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    appendFileSync(fixture.path, "{not valid json}\n");

    expect((await post(fixture)).status).toBe(400);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);
  });

  it.each(["truncate", "replace"])("rejects a shorter %s source and reconciles only the stored prefix", async (operation) => {
    const fixture = createTranscript(["first", "second", "third"].map(text => messageLine("user", text)));
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    const original = readFileSync(fixture.path, "utf8");
    const header = original.slice(0, original.indexOf("\n") + 1);
    const replacement = `${header}${messageLine("user", "unseen replacement")}\n`;
    if (operation === "replace") {
      writeFileSync(`${fixture.path}.new`, replacement);
      renameSync(`${fixture.path}.new`, fixture.path);
    } else {
      writeFileSync(fixture.path, replacement);
    }

    expect((await post(fixture)).status).toBe(400);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);
    appendFileSync(fixture.path, `${messageLine("user", "fourth")}\n${messageLine("user", "fifth")}\n`);
    // Matching the old count is insufficient when the source prefix differs.
    expect((await post(fixture)).status).toBe(400);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);

    writeFileSync(fixture.path, `${original}${messageLine("assistant", "recovered tail")}\n`);
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId).messages.map(message => message.content))
      .toEqual(["first", "second", "third", "recovered tail"]);
  });

  it("rejects a stale cursor already advanced by an older truncated-source capture", async () => {
    const fixture = createTranscript(["first", "second", "third"].map(text => messageLine("user", text)));
    await startDaemon();
    await post(fixture);
    const original = readFileSync(fixture.path, "utf8");
    const header = original.slice(0, original.indexOf("\n") + 1);
    writeFileSync(fixture.path, `${header}${messageLine("user", "replacement")}\n`);
    const db = new DatabaseSync(projectDbPath(fixture.cwd, paths));
    try {
      db.prepare("UPDATE codex_ingest_cursors SET byte_offset = ?, message_count = 1")
        .run(statSync(fixture.path).size);
    } finally { db.close(); }
    const before = readState(fixture.cwd, fixture.sessionId);
    appendFileSync(fixture.path, `${messageLine("assistant", "unseen new turn")}\n`);

    expect((await post(fixture)).status).toBe(400);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);
  });

  it("accepts a recovered prefix after applying the same redaction rules", async () => {
    const fixture = createTranscript([messageLine("user", "Project value MY_PROJECT_SECRET")]);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", {
      daemon: { port: 0 }, security: { sensitivePatterns: ["MY_PROJECT_SECRET"] },
    }));
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    expect(before.messages[0].content).not.toContain("MY_PROJECT_SECRET");
    const original = readFileSync(fixture.path, "utf8");
    writeFileSync(`${fixture.path}.new`, `${original}${messageLine("assistant", "new tail")}\n`);
    renameSync(`${fixture.path}.new`, fixture.path);

    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    expect(readState(fixture.cwd, fixture.sessionId).messages)
      .toEqual([...before.messages, { role: "assistant", content: "new tail" }]);
  });

  it("accepts unchanged history when new redaction rules are added", async () => {
    const fixture = createTranscript([messageLine("user", "Project value NEW_SECRET")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);
    expect(before.messages[0].content).toContain("NEW_SECRET");
    const original = readFileSync(fixture.path, "utf8");
    await daemon!.stop();
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", {
      daemon: { port: 0 }, security: { sensitivePatterns: ["NEW_SECRET"] },
    }));
    writeFileSync(`${fixture.path}.new`, `${original}${messageLine("assistant", "Follow-up NEW_SECRET")}\n`);
    renameSync(`${fixture.path}.new`, fixture.path);

    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    const after = readState(fixture.cwd, fixture.sessionId);
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(after.messages[1].content).toContain("Follow-up");
    expect(after.messages[1].content).not.toContain("NEW_SECRET");
  });

  it("rolls back appended messages when the cursor update fails and succeeds on retry", async () => {
    const fixture = createTranscript([messageLine("user", "committed")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);

    const dbPath = projectDbPath(fixture.cwd, paths);
    const triggerDb = new DatabaseSync(dbPath);
    try {
      triggerDb.exec(`
        CREATE TRIGGER reject_codex_cursor_update
        BEFORE UPDATE ON codex_ingest_cursors
        BEGIN
          SELECT RAISE(ABORT, 'cursor update rejected by test');
        END
      `);
    } finally {
      triggerDb.close();
    }
    appendFileSync(fixture.path, `${messageLine("assistant", "must roll back")}\n`);

    expect((await post(fixture)).status).toBe(500);
    expect(readState(fixture.cwd, fixture.sessionId)).toEqual(before);

    const cleanupDb = new DatabaseSync(dbPath);
    try {
      cleanupDb.exec("DROP TRIGGER reject_codex_cursor_update");
    } finally {
      cleanupDb.close();
    }
    expect(await post(fixture)).toMatchObject({ status: 200, body: { ingested: 1 } });
    const after = readState(fixture.cwd, fixture.sessionId);
    expect(after.cursor).toEqual({
      byte_offset: statSync(fixture.path).size,
      message_count: 2,
      record_boundary: 1,
    });
    expect(after.messages.map(message => message.content)).toEqual(["committed", "must roll back"]);
  });
});
