import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { projectId } from "../src/daemon/project.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { findUncompacted } from "../src/batch-compact.js";

const tempHomes: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeProject() {
  const home = mkdtempSync(join(tmpdir(), "lcm-batch-compact-"));
  tempHomes.push(home);
  const paths = createLcmPaths(home);
  const cwd = join(home, "workspace");
  const projectDir = join(paths.projectsDir, projectId(cwd));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }));

  const db = getLcmConnection(join(projectDir, "db.sqlite"));
  runLcmMigrations(db, { fts5Available: false });
  return { paths, cwd, db };
}

function createConversation(db: ReturnType<typeof getLcmConnection>, sessionId: string, updatedAt: string): number {
  const result = db
    .prepare("INSERT INTO conversations (session_id, updated_at) VALUES (?, ?)")
    .run(sessionId, updatedAt);
  return Number(result.lastInsertRowid);
}

function insertMessage(
  db: ReturnType<typeof getLcmConnection>,
  conversationId: number,
  seq: number,
  tokenCount: number,
): number {
  const result = db
    .prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'user', ?, ?)",
    )
    .run(conversationId, seq, `message-${conversationId}-${seq}`, tokenCount);
  return Number(result.lastInsertRowid);
}

function insertSummary(
  db: ReturnType<typeof getLcmConnection>,
  conversationId: number,
  summaryId: string,
  messageIds: number[],
): void {
  db.prepare(
    "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, 'leaf', 'summary', 5)",
  ).run(summaryId, conversationId);
  const link = db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)");
  for (const [ordinal, messageId] of messageIds.entries()) {
    link.run(summaryId, messageId, ordinal);
  }
}

function insertContextItem(
  db: ReturnType<typeof getLcmConnection>,
  conversationId: number,
  ordinal: number,
  itemType: "message" | "summary",
  id: number | string,
): void {
  if (itemType === "message") {
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)",
    ).run(conversationId, ordinal, id);
  } else {
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, 'summary', ?)",
    ).run(conversationId, ordinal, id);
  }
}

describe("findUncompacted", () => {
  it("selects only conversations with enough uncovered raw context", () => {
    const { paths, cwd, db } = makeProject();

    const partial = createConversation(db, "partial", "2026-01-02");
    const partialCovered = insertMessage(db, partial, 0, 100);
    const partialTailA = insertMessage(db, partial, 1, 6);
    const partialTailB = insertMessage(db, partial, 2, 6);
    insertSummary(db, partial, "sum-partial", [partialCovered]);
    insertContextItem(db, partial, 0, "summary", "sum-partial");
    insertContextItem(db, partial, 1, "message", partialTailA);
    insertContextItem(db, partial, 2, "message", partialTailB);

    const covered = createConversation(db, "covered", "2026-01-01");
    const coveredMessage = insertMessage(db, covered, 0, 100);
    insertSummary(db, covered, "sum-covered", [coveredMessage]);
    insertContextItem(db, covered, 0, "summary", "sum-covered");

    const raw = createConversation(db, "raw", "2026-01-03");
    const rawA = insertMessage(db, raw, 0, 7);
    const rawB = insertMessage(db, raw, 1, 8);
    insertContextItem(db, raw, 0, "message", rawA);
    insertContextItem(db, raw, 1, "message", rawB);

    const smallTail = createConversation(db, "small-tail", "2026-01-04");
    const smallCovered = insertMessage(db, smallTail, 0, 100);
    const smallRaw = insertMessage(db, smallTail, 1, 4);
    insertSummary(db, smallTail, "sum-small-tail", [smallCovered]);
    insertContextItem(db, smallTail, 0, "summary", "sum-small-tail");
    insertContextItem(db, smallTail, 1, "message", smallRaw);

    const candidates = findUncompacted(paths, 10, false, cwd);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["raw", "partial"]);
    expect(candidates[1]).toMatchObject({
      messages: 2,
      tokens: 12,
      sourceMessages: 2,
      sourceTokens: 12,
    });

    const replayCandidates = findUncompacted(paths, 10, true, cwd, true);
    expect(replayCandidates.map((candidate) => candidate.sessionId)).toEqual([
      "partial",
      "small-tail",
      "covered",
      "raw",
    ]);
  });
});
