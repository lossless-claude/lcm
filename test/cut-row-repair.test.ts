import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { planCutRowRepair, applyCutRowRepair } from "../src/cut-row-repair.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ScrubEngine } from "../src/scrub.js";
import { ConversationStore } from "../src/store/conversation-store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

for (const client of ["codex", "omp"] as const) {
  describe(`${client} cut-row repair`, () => {
    it("previews a cut row, restores its content and FTS, and leaves other rows untouched", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lcm-cut-repair-"));
      dirs.push(cwd);
      const db = new DatabaseSync(join(cwd, "db.sqlite"));
      try {
        runLcmMigrations(db);
        const sessionId = `${client}-cut`;
        const path = join(cwd, "transcript.jsonl");
        const turns = ["before\u0000uniqueafter", "untouched text"];
        const records = client === "codex" ? [
          { type: "session_meta", payload: { id: sessionId, cwd } },
          ...turns.map((text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })),
        ] : [
          { type: "session", id: sessionId, cwd },
          ...turns.map((text, i) => ({ type: "message", id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, message: { role: "user", content: [{ type: "text", text }] } })),
        ];
        writeFileSync(path, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
        const capture = new SessionCapture(db, "test-project", new ScrubEngine([], []));
        await capture.write({ sessionId, messages: turns.map((content) => ({ role: "user", content, tokenCount: 2 })) });
        const store = new ConversationStore(db);
        const original = await store.getSessionMessages(sessionId);
        db.prepare("UPDATE messages SET content = ? WHERE message_id = ?").run(turns[0], original[0].messageId);
        db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(original[0].messageId);
        db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(original[0].messageId, "before");

        const input = { sessionId, cwd, client, transcriptPath: path, scrub: (text: string) => text };
        const preview = await planCutRowRepair(db, input);
        expect(preview).toMatchObject({ kind: "repairable", rows: [{ messageId: original[0].messageId }] });
        expect((await store.getSessionMessages(sessionId))[0].content).toBe("before");
        applyCutRowRepair(db, preview);
        const after = await store.getSessionMessages(sessionId);
        expect(after.map((row) => row.messageId)).toEqual(original.map((row) => row.messageId));
        expect(after.map((row) => row.content)).toEqual(["before�uniqueafter", "untouched text"]);
        expect(store.searchMessagesSync({ mode: "full_text", query: "uniqueafter" }).map((row) => row.messageId)).toContain(original[0].messageId);
        expect((await planCutRowRepair(db, input)).kind).toBe("aligned");
      } finally { db.close(); }
    });
  });
}
