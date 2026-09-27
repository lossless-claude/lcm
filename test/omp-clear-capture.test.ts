import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ScrubEngine } from "../src/scrub.js";

/**
 * An OMP `/clear` appends a `reset_boundary` entry to the same session file under the same
 * session id. Capture stores each side of it as its own conversation: the turns before the
 * clear stay stored and searchable, and the session's newest conversation — the one restore
 * reads — holds only what followed the clear.
 */

const sessionId = "01a0c127-f3c1-7000-af32-68cf17f6be65";
const timestamp = "2026-09-20T23:30:16.129Z";
/** `[id, parentId]`: an entry's place in the session tree. */
type At = [string, string | null];
const say = ([id, parentId]: At, role: string, text: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }] } });
const clear = ([id, parentId]: At) => JSON.stringify({ type: "reset_boundary", id, parentId, timestamp });
const trunk = [say(["u1", null], "user", "first question"), say(["a1", "u1"], "assistant", "first answer")];

const tempDirs: string[] = [];
let db: DatabaseSync;
let capture: SessionCapture;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  capture = new SessionCapture(db, "proj", new ScrubEngine([], []));
});
afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionFile(lines: string[], name = "2026-09-20T23-30-16-129Z_session.jsonl"): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-omp-clear-"));
  tempDirs.push(cwd);
  const path = join(cwd, name);
  const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd });
  const text = `${[header, ...lines].join("\n")}\n`;
  writeFileSync(path, name.endsWith(".gz") ? gzipSync(text) : text);
  return { cwd, path };
}
const append = (path: string, lines: string[]) => appendFileSync(path, `${lines.join("\n")}\n`);
const captureFile = (file: { cwd: string; path: string }, source: "live" | "import" = "live") =>
  capture.captureTranscript({ sessionId, client: "omp", cwd: file.cwd, transcriptPath: file.path, source });

/** Every conversation of the session, oldest first: the clear that opened it and its messages in order. */
function conversations(): Array<{ openedBy: string | null; messages: string[] }> {
  const rows = db.prepare(
    "SELECT conversation_id, opened_by_entry_id FROM conversations WHERE session_id = ? ORDER BY conversation_id",
  ).all(sessionId) as Array<{ conversation_id: number; opened_by_entry_id: string | null }>;
  return rows.map((row) => ({
    openedBy: row.opened_by_entry_id,
    messages: (db.prepare("SELECT seq, content FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all(row.conversation_id) as Array<{ seq: number; content: string }>)
      .map(({ seq, content }, index) => {
        expect(seq).toBe(index);
        return content;
      }),
  }));
}

/** The newest conversation's cursor, which counts every message the session file has given. */
function cursorCount(): number | undefined {
  const row = db.prepare(
    `SELECT message_count FROM codex_ingest_cursors WHERE conversation_id =
       (SELECT MAX(conversation_id) FROM conversations WHERE session_id = ?)`,
  ).get(sessionId) as { message_count: number } | undefined;
  return row?.message_count;
}

describe("an OMP /clear starts a new stored conversation", () => {
  it("live capture across a clear: the turns before it stay in their own conversation", async () => {
    const file = sessionFile(trunk);
    await captureFile(file);
    append(file.path, [clear(["r1", "a1"]), say(["u2", "r1"], "user", "fresh start")]);
    const result = await captureFile(file);

    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["fresh start"] },
    ]);
    expect(result?.records.map((r) => r.content)).toEqual(["fresh start"]);
    expect(result?.conversationId).toBe(db.prepare("SELECT MAX(conversation_id) AS id FROM conversations").get()!.id);
    expect(cursorCount()).toBe(3);

    await captureFile(file);
    expect(conversations()).toHaveLength(2);
  });

  it("a clear with nothing after it opens an empty conversation, once, which later turns fill", async () => {
    const file = sessionFile([...trunk, clear(["r1", "a1"])]);
    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: [] },
    ]);

    await captureFile(file);
    expect(conversations()).toHaveLength(2);

    append(file.path, [say(["u2", "r1"], "user", "fresh start")]);
    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["fresh start"] },
    ]);
  });

  it("an import of a file with two clears stores three conversations", async () => {
    const file = sessionFile([
      ...trunk, clear(["r1", "a1"]), say(["u2", "r1"], "user", "second start"),
      clear(["r2", "u2"]), say(["u3", "r2"], "user", "third start"),
    ]);
    await captureFile(file, "import");
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["second start"] },
      { openedBy: "r2", messages: ["third start"] },
    ]);
    expect(cursorCount()).toBe(4);
  });

  it("an archived file with a clear is split the same way, and a second import adds nothing", async () => {
    const file = sessionFile([...trunk, clear(["r1", "a1"]), say(["u2", "r1"], "user", "fresh start")], "session.jsonl.gz");
    await captureFile(file, "import");
    await captureFile(file, "import");
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["fresh start"] },
    ]);
  });

  it("recovery after a clear re-reads the whole file without splitting or duplicating what is stored", async () => {
    const file = sessionFile([...trunk, clear(["r1", "a1"]), say(["u2", "r1"], "user", "fresh start")]);
    await captureFile(file);
    // OMP rewrites a session file atomically: the new inode invalidates the byte cursor.
    const copy = `${file.path}.copy`;
    writeFileSync(copy, readFileSync(file.path));
    renameSync(copy, file.path);
    append(file.path, [say(["u3", "u2"], "user", "after the rewrite")]);

    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["fresh start", "after the rewrite"] },
    ]);
    expect(cursorCount()).toBe(4);
  });

  it("recovery opens a conversation for a clear that follows stored history", async () => {
    const file = sessionFile(trunk);
    await captureFile(file);
    db.exec("DELETE FROM codex_ingest_cursors");
    append(file.path, [clear(["r1", "a1"]), say(["u2", "r1"], "user", "fresh start")]);

    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["fresh start"] },
    ]);
  });

  it("a conversation stored before clears were honoured is not split, and capture continues it", async () => {
    await capture.write({
      sessionId,
      messages: ["first question", "first answer", "fresh start"].map((content, index) =>
        ({ role: index % 2 ? "assistant" : "user", content, tokenCount: 1 })),
    });
    const file = sessionFile([...trunk, clear(["r1", "a1"]), say(["u2", "r1"], "user", "fresh start")]);
    await captureFile(file);
    append(file.path, [say(["a2", "u2"], "assistant", "fresh answer")]);
    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer", "fresh start", "fresh answer"] },
    ]);
  });

  it("a clear a rewind abandoned before capture opens nothing", async () => {
    const file = sessionFile([
      ...trunk, clear(["r1", "a1"]), say(["u2", "r1"], "user", "cleared turn"),
      JSON.stringify({ type: "branch_summary", id: "b1", parentId: "a1", timestamp, fromId: "u2", summary: "" }),
      say(["u3", "b1"], "user", "back before the clear"),
    ]);
    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer", "back before the clear"] },
    ]);
  });

  it("a rewind to before a stored clear reopens nothing: later turns go to the current conversation", async () => {
    const file = sessionFile([...trunk, clear(["r1", "a1"]), say(["u2", "r1"], "user", "fresh start")]);
    await captureFile(file);
    append(file.path, [
      JSON.stringify({ type: "branch_summary", id: "b1", parentId: "a1", timestamp, fromId: "u2", summary: "" }),
      say(["u3", "b1"], "user", "back before the clear"),
    ]);
    await captureFile(file);
    expect(conversations()).toEqual([
      { openedBy: null, messages: ["first question", "first answer"] },
      { openedBy: "r1", messages: ["fresh start", "back before the clear"] },
    ]);
  });
});
