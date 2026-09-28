import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCapture } from "../../../src/capture.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectDir } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { repairCutRows } from "../../../src/import.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { ScrubEngine } from "../../../src/scrub.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";

const paths = createLcmPaths(lcmHome());
const dirs: string[] = [];
let daemon: DaemonInstance | undefined;
afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  for (const cwd of dirs.splice(0)) {
    rmSync(projectDir(cwd, paths), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const provider of ["codex", "omp"] as const) {
  describe(`${provider} import --rebuild`, () => {
    it("previews without writes, backs up, and repairs only the matched cut row through the daemon", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lcm-cut-route-"));
      dirs.push(cwd);
      const sessionId = `${provider}-repair-route`;
      const sourceDir = provider === "codex" ? join(homedir(), ".codex") : join(homedir(), ".omp", "agent");
      const transcriptDir = provider === "codex" ? join(sourceDir, "sessions") : join(sourceDir, "sessions", "bucket");
      mkdirSync(transcriptDir, { recursive: true });
      const path = join(transcriptDir, `${sessionId}.jsonl`);
      const turns = ["head\u0000findabletail", "leave this row"];
      const records = provider === "codex" ? [
        { type: "session_meta", payload: { id: sessionId, cwd } },
        ...turns.map((text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })),
      ] : [
        { type: "session", id: sessionId, cwd },
        ...turns.map((text, index) => ({ type: "message", id: `row-${index}`, parentId: index ? `row-${index - 1}` : null, message: { role: "user", content: [{ type: "text", text }] } })),
      ];
      writeFileSync(path, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
      mkdirSync(projectDir(cwd, paths), { recursive: true });
      const dbPath = projectDbPath(cwd, paths);
      const db = new DatabaseSync(dbPath);
      let messageIds: number[];
      try {
        runLcmMigrations(db);
        await new SessionCapture(db, "test-project", new ScrubEngine([], [])).write({
          sessionId, messages: turns.map((content) => ({ role: "user", content, tokenCount: 2 })),
        });
        messageIds = (await new ConversationStore(db).getSessionMessages(sessionId)).map((row) => row.messageId);
        db.prepare("UPDATE messages SET content = ? WHERE message_id = ?").run(turns[0], messageIds[0]);
        db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(messageIds[0]);
        db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(messageIds[0], "head");
      } finally { db.close(); }
      const options = { paths, cwd, provider, _codexDir: sourceDir, _ompDir: sourceDir };
      const preview = await repairCutRows(undefined, options);
      expect(preview.sessions).toEqual([expect.objectContaining({ plan: expect.objectContaining({ kind: "repairable", rows: [expect.objectContaining({ messageId: messageIds![0] })] }) })]);
      expect(existsSync(`${dbPath}.bak-rebuild-`)).toBe(false);

      daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
      const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, join(cwd, "missing-token"));
      const applied = await repairCutRows(client, { ...options, apply: true });
      expect(applied.sessions[0]).toMatchObject({ repaired: 1, plan: { kind: "repairable" } });
      expect(existsSync(applied.sessions[0].backupPath!)).toBe(true);
      const read = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const store = new ConversationStore(read);
        expect((await store.getSessionMessages(sessionId)).map((row) => [row.messageId, row.content])).toEqual([
          [messageIds![0], "head�findabletail"], [messageIds![1], "leave this row"],
        ]);
        expect(store.searchMessagesSync({ mode: "full_text", query: "findabletail" }).map((row) => row.messageId)).toContain(messageIds![0]);
      } finally { read.close(); }
      expect((await repairCutRows(undefined, options)).sessions[0].plan.kind).toBe("aligned");
    });

    it("backs a project up once however many of its sessions it repairs", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lcm-cut-once-"));
      dirs.push(cwd);
      const sourceDir = provider === "codex" ? join(homedir(), ".codex") : join(homedir(), ".omp", "agent");
      const transcriptDir = provider === "codex" ? join(sourceDir, "sessions") : join(sourceDir, "sessions", "bucket");
      mkdirSync(transcriptDir, { recursive: true });
      mkdirSync(projectDir(cwd, paths), { recursive: true });
      const dbPath = projectDbPath(cwd, paths);
      const sessions = [`${provider}-once-a`, `${provider}-once-b`];
      const db = new DatabaseSync(dbPath);
      try {
        runLcmMigrations(db);
        for (const sessionId of sessions) {
          const text = `head ${sessionId}\u0000tail`;
          const records = provider === "codex"
            ? [{ type: "session_meta", payload: { id: sessionId, cwd } }, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }]
            : [{ type: "session", id: sessionId, cwd }, { type: "message", id: "row-0", parentId: null, message: { role: "user", content: [{ type: "text", text }] } }];
          writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), records.map((row) => JSON.stringify(row)).join("\n") + "\n");
          await new SessionCapture(db, "test-project", new ScrubEngine([], [])).write({ sessionId, messages: [{ role: "user", content: text, tokenCount: 2 }] });
          const [row] = await new ConversationStore(db).getSessionMessages(sessionId);
          db.prepare("UPDATE messages SET content = ? WHERE message_id = ?").run(text, row.messageId);
        }
      } finally { db.close(); }

      daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
      const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, join(cwd, "missing-token"));
      const applied = await repairCutRows(client, { paths, cwd, provider, _codexDir: sourceDir, _ompDir: sourceDir, apply: true });
      const repaired = applied.sessions.filter((report) => sessions.includes(report.plan.sessionId));
      expect(repaired.map((report) => report.repaired)).toEqual([1, 1]);
      expect(repaired.filter((report) => report.backupPath !== undefined)).toHaveLength(1);
      expect(readdirSync(projectDir(cwd, paths)).filter((name) => name.includes(".bak-rebuild-"))).toHaveLength(1);
    });
  });
}
