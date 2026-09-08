import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";

type RestoreBody = { context: string };

async function seedConversation(input: {
  cwd: string;
  sessionId: string;
  summary?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<void> {
  const dbPath = projectDbPath(input.cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    runLcmMigrations(db);
    const conversations = new ConversationStore(db, { fts5Available: false });
    const summaries = new SummaryStore(db, { fts5Available: false });
    const conversation = await conversations.createConversation({ sessionId: input.sessionId });

    if (input.summary) {
      const summaryId = `${input.sessionId}-summary`;
      await summaries.insertSummary({
        summaryId,
        conversationId: conversation.conversationId,
        kind: "leaf",
        content: input.summary,
        tokenCount: 20,
      });
      await summaries.appendContextSummary(conversation.conversationId, summaryId);
    }

    for (const [seq, message] of (input.messages ?? []).entries()) {
      const record = await conversations.createMessage({
        conversationId: conversation.conversationId,
        seq,
        role: message.role,
        content: message.content,
        tokenCount: 20,
      });
      await summaries.appendContextMessage(conversation.conversationId, record.messageId);
    }
  } finally {
    db.close();
  }
}

describe("POST /restore for Codex", () => {
  let daemon: DaemonInstance | undefined;
  const tempProjects: Array<{ cwd: string; dbDir: string }> = [];

  function makeProject(): string {
    const cwd = mkdtempSync(join(tmpdir(), "codex-restore-test-"));
    tempProjects.push({ cwd, dbDir: dirname(projectDbPath(cwd)) });
    return cwd;
  }

  async function restore(cwd: string, sessionId: string, source: string): Promise<RestoreBody> {
    const response = await fetch(`http://127.0.0.1:${daemon!.address().port}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "codex", session_id: sessionId, cwd, source }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<RestoreBody>;
  }

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const project of tempProjects.splice(0)) {
      rmSync(project.dbDir, { recursive: true, force: true });
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });

  it("restores the current summary and unsummarized tail on resume and after compaction", async () => {
    const cwd = makeProject();
    await seedConversation({
      cwd,
      sessionId: "codex-current",
      summary: "Earlier work selected the durable cursor design.",
      messages: [
        { role: "user", content: "Keep the restore route project-scoped." },
        { role: "assistant", content: "The implementation now queries only this SQLite database." },
      ],
    });
    daemon = await createDaemon(loadDaemonConfig(cwd, { daemon: { port: 0 } }));

    for (const source of ["resume", "compact"]) {
      const body = await restore(cwd, "codex-current", source);
      expect(body.context).toContain("<recent-session-context>");
      expect(body.context).toContain("durable cursor design");
      expect(body.context).toContain("Keep the restore route project-scoped.");
      expect(body.context).toContain("queries only this SQLite database");
    }
  });

  it("falls back to recent messages when no summarizer output exists", async () => {
    const cwd = makeProject();
    await seedConversation({
      cwd,
      sessionId: "codex-unsummarized",
      messages: [
        { role: "user", content: "This fact exists only in the raw turn tail." },
        { role: "assistant", content: "It must survive a native resume." },
      ],
    });
    daemon = await createDaemon(loadDaemonConfig(cwd, { daemon: { port: 0 } }));

    const body = await restore(cwd, "codex-unsummarized", "resume");
    expect(body.context).toContain("This fact exists only in the raw turn tail.");
    expect(body.context).toContain("It must survive a native resume.");
  });

  it("gives a metadata-only new startup recent memory from its project only", async () => {
    const cwd = makeProject();
    const otherCwd = makeProject();
    await seedConversation({
      cwd,
      sessionId: "previous-local-session",
      summary: "Local project uses a resumable manifest.",
    });
    await seedConversation({
      cwd: otherCwd,
      sessionId: "other-project-session",
      summary: "Foreign project secret must stay isolated.",
    });
    // SessionStart ingestion may have already created this empty shell from session_meta.
    await seedConversation({ cwd, sessionId: "brand-new-codex-session" });
    daemon = await createDaemon(loadDaemonConfig(cwd, { daemon: { port: 0 } }));

    const body = await restore(cwd, "brand-new-codex-session", "startup");
    expect(body.context).toContain("<recent-project-context>");
    expect(body.context).toContain("Local project uses a resumable manifest.");
    expect(body.context).not.toContain("Foreign project secret");
  });

  it("never reads, replays, or overwrites the Claude instruction snapshot", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "CLAUDE.md"), "NEW CLAUDE FILE MUST NOT BE READ", "utf8");
    await seedConversation({
      cwd,
      sessionId: "codex-no-claude",
      messages: [{ role: "user", content: "Codex-owned context remains available." }],
    });
    const dbPath = projectDbPath(cwd);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO session_instructions (id, content, content_hash, updated_at)
       VALUES (1, ?, ?, datetime('now'))`,
    ).run("OLD CLAUDE SNAPSHOT MUST NOT BE REPLAYED", "stable-hash");
    db.close();
    daemon = await createDaemon(loadDaemonConfig(cwd, { daemon: { port: 0 } }));

    for (const source of ["startup", "compact"]) {
      const body = await restore(cwd, "codex-no-claude", source);
      expect(body.context).toContain("Codex-owned context remains available.");
      expect(body.context).not.toContain("CLAUDE");
      expect(body.context).not.toContain("<project-instructions>");
    }

    const verificationDb = new DatabaseSync(dbPath);
    const snapshot = verificationDb.prepare(
      `SELECT content, content_hash FROM session_instructions WHERE id = 1`,
    ).get();
    verificationDb.close();
    expect(snapshot).toEqual({
      content: "OLD CLAUDE SNAPSHOT MUST NOT BE REPLAYED",
      content_hash: "stable-hash",
    });
  });

  it("keeps the fenced restore context within maxInjectedMemoryBytes", async () => {
    const cwd = makeProject();
    await seedConversation({
      cwd,
      sessionId: "codex-bounded",
      summary: `OLDER-SUMMARY ${"s".repeat(500)}`,
      messages: [{ role: "user", content: `NEWEST-CONTEXT ${"x".repeat(500)}` }],
    });
    daemon = await createDaemon(loadDaemonConfig(cwd, {
      daemon: { port: 0 },
      restoration: { maxInjectedMemoryBytes: 220 },
    }));

    const body = await restore(cwd, "codex-bounded", "resume");
    expect(Buffer.byteLength(body.context, "utf8")).toBeLessThanOrEqual(220);
    expect(body.context).toContain("NEWEST-CONTEXT");
    expect(body.context).toContain("</recent-session-context>");
  });
});
