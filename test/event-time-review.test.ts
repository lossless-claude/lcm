import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { backfillSessionEventTimes } from "../src/event-time-backfill.js";
import { rebuildClaudeSessions } from "../src/import.js";
import { planCutRowRepair } from "../src/cut-row-repair.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { claudeProjectSlug, projectDbPath, projectDir } from "../src/daemon/project.js";
import { ScrubEngine } from "../src/scrub.js";
import { ConversationStore } from "../src/store/conversation-store.js";

let dir: string;
let db: DatabaseSync;
let capture: SessionCapture;
const at = "2021-02-03T04:05:06.123Z";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcm-event-review-"));
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { claudeProjectsDir: dir });
  capture = new SessionCapture(db, "project", new ScrubEngine([], []));
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); });

it("lists conversations without accessing messages or message parts", async () => {
  await capture.write({ sessionId: "session", messages: [{ role: "user", content: "source", tokenCount: 1 }] });
  const statements: string[] = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => { statements.push(sql); return prepare(sql); });
  expect(await capture.conversationStore.listConversations()).toHaveLength(1);
  const selects = statements.filter(sql => sql.includes("FROM conversations"));
  expect(selects).toHaveLength(1);
  const plan = prepare(`EXPLAIN QUERY PLAN ${selects[0]}`).all() as Array<{ detail: string }>;
  expect(plan.some(row => /\b(messages|message_parts|m|p)\b/.test(row.detail))).toBe(false);
});

it.each(["claude", "omp"] as const)("pages %s backfill by indexed sequence with linear row visits across clears", async client => {
  const count = 1100;
  const messages = Array.from({ length: count }, (_, index) => ({ role: "user", content: `message ${index}`, tokenCount: 1 }));
  const { conversationId } = await capture.write({ sessionId: "session", messages, boundaries: [{ entryId: "clear", at: 550 }] });
  const event = await capture.conversationStore.createMessage({ conversationId, seq: 550, role: "system", content: "compaction", tokenCount: 1 });
  await capture.conversationStore.createMessageParts(event.messageId, [{ sessionId: "session", ordinal: 0, partType: "compaction" }]);
  const path = join(dir, "session.jsonl");
  const entries = client === "claude" ? messages.map(message => ({ timestamp: at, message }))
    : [{ type: "session", id: "session", cwd: dir }, ...messages.map((message, index) => ({
      type: "message", id: `turn-${index}`, parentId: index ? `turn-${index - 1}` : null, timestamp: at, message,
    }))];
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  let visits = 0;
  db.function("visit_message", () => { visits++; return 1; });
  const prepare = db.prepare.bind(db);
  const plans: string[][] = [], sizes: number[] = [];
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (!sql.includes("SELECT m.message_id") || !sql.includes("FROM messages m")) return prepare(sql);
    const statement = prepare(sql.replace("ORDER BY", "AND visit_message() ORDER BY"));
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...args) => {
      plans.push((prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(row => row.detail));
      const rows = all(...args); sizes.push(rows.length); return rows;
    });
    return statement;
  });
  expect(await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path, client }, new ScrubEngine([], [])))
    .toEqual({ updated: count, unknown: 0 });
  expect(plans.length).toBeGreaterThan(4);
  for (const plan of plans) {
    expect(plan.some(detail => detail.includes("USE TEMP B-TREE"))).toBe(false);
    expect(plan.some(detail => /SEARCH m USING (?:COVERING )?INDEX .*\(conversation_id=\? AND seq>\?\)/.test(detail))).toBe(true);
  }
  expect(Math.max(...sizes)).toBeLessThanOrEqual(256);
  expect(visits).toBeLessThanOrEqual((client === "omp" ? 2 : 1) * (count + 1));
  expect(db.prepare("SELECT event_at FROM messages WHERE message_id = ?").get(event.messageId)).toEqual({ event_at: null });
});

it("recomputes summary bounds in indexed depth/id pages with linear row visits", async () => {
  const { conversationId, records } = await capture.write({ sessionId: "session", messages: [{ role: "user", content: "source", tokenCount: 1, eventAt: at }] });
  const count = 300;
  for (let index = 0; index < count; index++) {
    const id = `summary-${String(index).padStart(3, "0")}`;
    await capture.summaryStore.insertSummary({ summaryId: id, conversationId, kind: index ? "condensed" : "leaf", depth: index,
      content: "source summary", tokenCount: 1 });
    if (index) await capture.summaryStore.linkSummaryToParents(id, [`summary-${String(index - 1).padStart(3, "0")}`]);
    else await capture.summaryStore.linkSummaryToMessages(id, [records[0].messageId]);
  }
  let visits = 0;
  db.function("visit_summary", () => { visits++; return 1; });
  const prepare = db.prepare.bind(db);
  const plans: string[][] = [];
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (!sql.includes("SELECT summary_id, depth, kind")) return prepare(sql);
    const statement = prepare(sql.replace("ORDER BY", "AND visit_summary() ORDER BY"));
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...args) => {
      plans.push((prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(row => row.detail));
      return all(...args);
    });
    return statement;
  });
  await capture.summaryStore.recomputeTimeBounds(conversationId);
  expect(plans).toHaveLength(3);
  for (const plan of plans) {
    expect(plan.some(detail => detail.includes("USE TEMP B-TREE"))).toBe(false);
    expect(plan.some(detail => /SEARCH summaries USING (?:COVERING )?INDEX .*\(conversation_id=\? AND \(depth,summary_id\)>\(\?,\?\)\)/.test(detail))).toBe(true);
  }
  expect(visits).toBe(count);
  expect((await capture.summaryStore.getSummary("summary-299"))?.earliestAt?.toISOString()).toBe(at);
});

it("previews Claude rebuild on an unmigrated read-only store without modifying its schema", async () => {
  const paths = createLcmPaths(join(dir, "memory"));
  mkdirSync(projectDir(dir, paths), { recursive: true });
  const legacy = new DatabaseSync(projectDbPath(dir, paths));
  runLcmMigrations(legacy, { claudeProjectsDir: dir });
  await new SessionCapture(legacy, "project", new ScrubEngine([], [])).write({ sessionId: "session", messages: [{ role: "user", content: "first", tokenCount: 1 }] });
  legacy.exec("ALTER TABLE messages DROP COLUMN event_at; ALTER TABLE conversations DROP COLUMN parser_shape");
  const schema = legacy.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  legacy.close();
  const transcripts = join(dir, "transcripts");
  const project = join(transcripts, claudeProjectSlug(dir)); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "session.jsonl"), JSON.stringify({ message: { role: "user", content: "first" } }) + "\n");
  const result = await rebuildClaudeSessions(undefined, { paths, cwd: dir, _claudeProjectsDir: transcripts });
  expect(result.failedProjects).toEqual([]);
  expect(result.sessions).toMatchObject([{ plan: { sessionId: "session", kind: "aligned" } }]);
  const check = new DatabaseSync(projectDbPath(dir, paths), { readOnly: true });
  try { expect(check.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema); }
  finally { check.close(); }
});

it.each(["codex", "omp"] as const)("previews %s cut-row repair on an unmigrated read-only store", async client => {
  const dbPath = join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(dbPath);
  runLcmMigrations(legacy, { claudeProjectsDir: dir });
  await new SessionCapture(legacy, "project", new ScrubEngine([], [])).write({ sessionId: "session", messages: [{ role: "user", content: "before", tokenCount: 1 }] });
  legacy.exec("ALTER TABLE messages DROP COLUMN event_at"); legacy.close();
  const path = join(dir, "session.jsonl");
  const entries = client === "codex" ? [{ type: "session_meta", payload: { id: "session", cwd: dir } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: "before\u0000after" } }]
    : [{ type: "session", id: "session", cwd: dir },
      { type: "message", id: "turn", parentId: null, timestamp: at, message: { role: "user", content: "before\u0000after" } }];
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const readOnly = new DatabaseSync(dbPath, { readOnly: true });
  try {
    expect((await new ConversationStore(readOnly).getSessionMessages("session"))[0].eventAt).toBeNull();
    expect(await planCutRowRepair(readOnly, { sessionId: "session", cwd: dir, client, transcriptPath: path, scrub: text => text }))
      .toMatchObject({ kind: "repairable", rows: [{ content: "before�after", eventAt: at }] });
  } finally { readOnly.close(); }
});

it.each(["claude", "codex"] as const)("never resumes %s positional alignment after divergence across a page or a clear", async client => {
  const messages = Array.from({ length: 520 }, (_, index) => ({ role: "user", content: `message ${index}`, tokenCount: 1 }));
  await capture.write({ sessionId: "session", messages, boundaries: [{ entryId: "clear", at: 300 }] });
  // Already-known rows must still establish the prefix before any unknown suffix takes a time.
  db.exec(`UPDATE messages SET event_at = '${at}' WHERE seq < 255 AND conversation_id = 1`);
  const path = join(dir, "session.jsonl");
  const transcript = messages.map((message, index) => ({ ...message, content: index === 255 ? "divergent" : message.content }));
  const entries = client === "claude" ? transcript.map(message => ({ timestamp: at, message }))
    : [{ type: "session_meta", payload: { id: "session", cwd: dir } }, ...transcript.map(message => ({ type: "response_item", timestamp: at, payload: { type: "message", ...message } }))];
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  expect(await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path, client }, new ScrubEngine([], [])))
    .toEqual({ updated: 0, unknown: 265 });
});
