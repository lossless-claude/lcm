import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { retagConversation, retagEntries } from "../src/retag.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const entry = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

function transcript(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-retag-"));
  tempDirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

/** A conversation as the pre-tagging parser stored it: every row under user/assistant. */
function legacyConversation(rows: Array<{ role: string; content: string }>): { db: DatabaseSync; id: number } {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  db.prepare("INSERT INTO conversations (session_id, title) VALUES (?, ?)").run("s1", null);
  const id = Number((db.prepare("SELECT conversation_id FROM conversations").get() as any).conversation_id);
  db.prepare("UPDATE conversations SET role_tagging = NULL WHERE conversation_id = ?").run(id);
  const insert = db.prepare(
    "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?)",
  );
  rows.forEach((row, seq) => insert.run(id, seq, row.role, row.content, 1));
  return { db, id };
}

const rolesOf = (db: DatabaseSync, id: number) =>
  (db.prepare("SELECT role FROM messages WHERE conversation_id = ? ORDER BY seq").all(id) as any[])
    .map(r => r.role);

describe("retagEntries", () => {
  it("keeps exactly the rows the old parser stored, in order", () => {
    const path = transcript([
      entry("user", [{ type: "text", text: "roda os testes" }]),
      entry("assistant", [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }]),
      entry("user", [{ type: "tool_result", content: "2 passed" }]),
      entry("assistant", [{ type: "text", text: "passou" }]),
    ]);
    // The tool call extracted to nothing back then and was skipped; adding it
    // now would shift every later seq.
    expect(retagEntries(path)).toEqual([
      { content: "roda os testes", role: "user" },
      { content: "2 passed", role: "tool" },
      { content: "passou", role: "assistant" },
    ]);
  });
});

describe("retagConversation", () => {
  it("re-labels a tool result that was stored as the user speaking", () => {
    const path = transcript([
      entry("user", [{ type: "text", text: "roda os testes" }]),
      entry("user", [{ type: "tool_result", content: "2 passed" }]),
    ]);
    const { db, id } = legacyConversation([
      { role: "user", content: "roda os testes" },
      { role: "user", content: "2 passed" },
    ]);
    try {
      expect(retagConversation(db, id, path)).toEqual({ retagged: 1, unchanged: 1 });
      expect(rolesOf(db, id)).toEqual(["user", "tool"]);
    } finally { db.close(); }
  });

  it("marks the conversation tagged once it has been checked", () => {
    const path = transcript([entry("user", [{ type: "tool_result", content: "2 passed" }])]);
    const { db, id } = legacyConversation([{ role: "user", content: "2 passed" }]);
    try {
      retagConversation(db, id, path);
      const row = db.prepare("SELECT role_tagging FROM conversations WHERE conversation_id = ?").get(id) as any;
      expect(row.role_tagging).toBe("tagged");
    } finally { db.close(); }
  });

  it("labels the stored rows when the transcript kept growing after ingest", () => {
    const path = transcript([
      entry("user", [{ type: "tool_result", content: "2 passed" }]),
      entry("assistant", [{ type: "text", text: "a turn recorded after the ingest" }]),
    ]);
    const { db, id } = legacyConversation([{ role: "user", content: "2 passed" }]);
    try {
      expect(retagConversation(db, id, path)).toEqual({ retagged: 1, unchanged: 0 });
      expect(rolesOf(db, id)).toEqual(["tool"]);
    } finally { db.close(); }
  });

  it("refuses when the store holds rows the transcript does not", () => {
    const path = transcript([entry("user", [{ type: "tool_result", content: "2 passed" }])]);
    const { db, id } = legacyConversation([
      { role: "user", content: "2 passed" },
      { role: "assistant", content: "an extra row the transcript does not have" },
    ]);
    try {
      expect(retagConversation(db, id, path).skipped).toBe("length-mismatch");
      expect(rolesOf(db, id)).toEqual(["user", "assistant"]);
    } finally { db.close(); }
  });

  it("refuses when the text disagrees, rather than guessing from position", () => {
    const path = transcript([entry("user", [{ type: "tool_result", content: "2 passed" }])]);
    const { db, id } = legacyConversation([{ role: "user", content: "something else entirely" }]);
    try {
      expect(retagConversation(db, id, path).skipped).toBe("content-mismatch");
      expect(rolesOf(db, id)).toEqual(["user"]);
    } finally { db.close(); }
  });

  it("reports a missing transcript instead of touching the rows", () => {
    const { db, id } = legacyConversation([{ role: "user", content: "2 passed" }]);
    try {
      expect(retagConversation(db, id, "/no/such/transcript.jsonl").skipped).toBe("no-transcript");
      expect(rolesOf(db, id)).toEqual(["user"]);
    } finally { db.close(); }
  });

  it("leaves an already tagged conversation alone", () => {
    const path = transcript([entry("user", [{ type: "tool_result", content: "2 passed" }])]);
    const { db, id } = legacyConversation([{ role: "user", content: "2 passed" }]);
    try {
      db.prepare("UPDATE conversations SET role_tagging = 'tagged' WHERE conversation_id = ?").run(id);
      expect(retagConversation(db, id, path).skipped).toBe("already-tagged");
      expect(rolesOf(db, id)).toEqual(["user"]);
    } finally { db.close(); }
  });

  it("does not delete or insert a single row", () => {
    const path = transcript([
      entry("user", [{ type: "text", text: "oi" }]),
      entry("user", [{ type: "tool_result", content: "2 passed" }]),
    ]);
    const { db, id } = legacyConversation([
      { role: "user", content: "oi" },
      { role: "user", content: "2 passed" },
    ]);
    try {
      const before = db.prepare("SELECT message_id FROM messages ORDER BY seq").all();
      retagConversation(db, id, path);
      expect(db.prepare("SELECT message_id FROM messages ORDER BY seq").all()).toEqual(before);
    } finally { db.close(); }
  });
});
