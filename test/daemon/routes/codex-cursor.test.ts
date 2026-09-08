import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";

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
  projectDirs.push(dirname(projectDbPath(cwd)));
  return { cwd, path, sessionId };
}

function readState(cwd: string, sessionId: string): StoredState {
  const db = new DatabaseSync(projectDbPath(cwd));
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

  it("rolls back appended messages when the cursor update fails and succeeds on retry", async () => {
    const fixture = createTranscript([messageLine("user", "committed")]);
    await startDaemon();
    await post(fixture);
    const before = readState(fixture.cwd, fixture.sessionId);

    const dbPath = projectDbPath(fixture.cwd);
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
