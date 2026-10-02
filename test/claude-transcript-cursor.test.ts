import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { NATIVE_PATTERNS, ScrubEngine } from "../src/scrub.js";
import { EventsDb } from "../src/hooks/events-db.js";
import { parseTranscript } from "../src/transcript.js";
import { claudeRebuildCandidateIds } from "../src/claude-rebuild.js";
import { WorkerStore } from "../src/store/worker-store.js";

const io = { path: "" };

let dir: string;
let db: DatabaseSync;
afterEach(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const line = (content: string) => JSON.stringify({ message: { role: "user", content } }) + "\n";
function fixture() {
  dir = mkdtempSync(join(tmpdir(), "lcm-claude-cursor-"));
  db = new DatabaseSync(join(dir, "db.sqlite"));
  runLcmMigrations(db);
  io.path = join(dir, "session.jsonl");
  const input = { sessionId: "session", cwd: dir, transcriptPath: io.path };
  const capture = new SessionCapture(db, "proj", new ScrubEngine([], []));
  return { input, capture };
}

it("records main-chain web declarations on full and incremental hook capture without creating messages", async () => {
  const { input, capture } = fixture();
  const declaration = (url: string, isSidechain = false, sessionId = "session") => JSON.stringify({
    type: "attachment", sessionId, isSidechain, attachment: { type: "remote_session_change", url },
  }) + "\n";
  const first = "https://claude.ai/code/session_first";
  const resumed = "https://claude.ai/code/session_resumed";
  writeFileSync(io.path, declaration(first) + line("one") + declaration(first));
  expect((await capture.captureTranscript(input))?.records.map(record => record.content)).toEqual(["one"]);
  appendFileSync(io.path, declaration(resumed) + declaration(first, true) +
    declaration("https://claude.ai/code/session_subagent", true) +
    declaration("https://claude.ai/code/session_other", false, "other"));
  expect((await capture.captureTranscript(input))?.records).toEqual([]);
  expect(db.prepare("SELECT session_id, url FROM session_web_urls ORDER BY url").all()).toEqual([
    { session_id: "session", url: first }, { session_id: "session", url: resumed },
  ]);
  expect(await capture.conversationStore.getSessionMessageCount("session")).toBe(1);
  expect((await capture.captureTranscript(input))?.records).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) count FROM session_web_urls").get()).toEqual({ count: 2 });
});

it("keeps declarations out of a write refused by the worker gate", async () => {
  const { capture } = fixture();
  new WorkerStore(db).exclude("session", dir, "claude");
  const result = await capture.write({ sessionId: "session", messages: [],
    sessionUrlDeclarations: [{ sessionId: "session", url: "https://claude.ai/code/session_worker" }] });
  expect(result.records).toEqual([]);
  expect(db.prepare("SELECT * FROM session_web_urls").all()).toEqual([]);
});

it("recovers declarations before an older parser's byte cursor", async () => {
  const { input, capture } = fixture();
  const url = "https://claude.ai/code/session_before_cursor";
  writeFileSync(io.path, JSON.stringify({ type: "attachment", sessionId: "session",
    attachment: { type: "remote_session_change", url } }) + "\n" + line("one"));
  await capture.captureTranscript(input);
  db.exec("DELETE FROM session_web_urls; UPDATE conversations SET parser_shape = 'claude-v4'");
  expect((await capture.captureTranscript(input))?.records).toEqual([]);
  expect(db.prepare("SELECT session_id, url FROM session_web_urls").all()).toEqual([{ session_id: "session", url }]);
});

it("parses only the append after reopening the database and forgetting the prefix memo", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, Array.from({ length: 128 }, (_, i) => line(`turn ${i} ${"x".repeat(1_500)}`)).join(""));
  const first = await capture.captureTranscript(input);
  const event = await capture.conversationStore.createMessage({ conversationId: first!.conversationId, seq: 128, role: "system", content: "compacted", tokenCount: 1 });
  await capture.conversationStore.createMessageParts(event.messageId, [{ sessionId: "session", partType: "compaction", ordinal: 0 }]);
  const append = line("next turn");
  appendFileSync(io.path, append);
  db.close();
  db = new DatabaseSync(join(dir, "db.sqlite"));
  vi.resetModules();
  const fresh = await import("../src/capture.js");
  const reopened = new fresh.SessionCapture(db, "proj", new ScrubEngine([], []));
  const rows = vi.spyOn(reopened.conversationStore, "getSessionMessages");
  const parsed = vi.spyOn(JSON, "parse");
  const result = await reopened.captureTranscript(input);
  expect(result?.records.map(({ content }) => content)).toEqual(["next turn"]);
  expect(parsed.mock.calls.length).toBeLessThan(16);
  expect(rows).not.toHaveBeenCalled();
  expect(db.prepare("SELECT message_count FROM codex_ingest_cursors").get()).toEqual({ message_count: 129 });
}, 15_000);

it("parses only new records for repeated captures in the same process", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, Array.from({ length: 100 }, (_, i) => line(`turn ${i}`)).join(""));
  await capture.captureTranscript(input);
  const parsed = vi.spyOn(JSON, "parse");
  appendFileSync(io.path, line("next"));
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["next"]);
  expect(parsed.mock.calls.length).toBeLessThan(16);
});

it.each(["rewrite", "truncate", "replace", "changed prefix"])("falls back to the full prefix guard after a %s", async (change) => {
  const { input, capture } = fixture();
  const original = line("one") + line("two");
  writeFileSync(io.path, original);
  await capture.captureTranscript(input);
  const cursor = db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get();
  if (change === "truncate") writeFileSync(io.path, line("one"));
  if (change === "rewrite") writeFileSync(io.path, line("two") + line("one") + line("tail"));
  if (change === "replace") {
    writeFileSync(`${io.path}.replacement`, original + line("tail"));
    renameSync(`${io.path}.replacement`, io.path);
  }
  if (change === "changed prefix") writeFileSync(io.path, line("bad") + line("two") + line("tail"));
  const rows = vi.spyOn(capture.conversationStore, "getSessionMessages");
  const result = capture.captureTranscript(input);
  if (change === "replace") expect((await result)?.records.map(r => r.content)).toEqual(["tail"]);
  else {
    await expect(result).rejects.toThrow("--rebuild");
    expect(db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get()).toEqual(cursor);
  }
  // A truncation is rejected before loading stored rows.
  if (change !== "truncate") expect(rows).toHaveBeenCalledExactlyOnceWith("session", 0);
  expect(await capture.conversationStore.getSessionMessageCount("session")).toBe(change === "replace" ? 3 : 2);
});

it("does not consume a partial UTF-8 last line, and captures it once complete", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one"));
  await capture.captureTranscript(input);
  const cursor = db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get();
  const tail = Buffer.from(line("after café"));
  const split = tail.indexOf(Buffer.from("é")) + 1;
  appendFileSync(io.path, tail.subarray(0, split));
  expect((await capture.captureTranscript(input))?.records).toEqual([]);
  expect(db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get()).toEqual(cursor);
  appendFileSync(io.path, tail.subarray(split));
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["after café"]);
  expect((await capture.captureTranscript(input))?.records).toEqual([]);
});

it("counts the full parser's filtered messages, including tools and multi-block text", async () => {
  const { input, capture } = fixture();
  const entries = [
    { type: "progress" }, { message: { role: "assistant", content: [{ type: "thinking", text: "hidden" }] } },
    { message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", id: "skill", input: { skill: "tdd" } }] } },
    { message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "before\u0000after" }] } },
    { message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } },
    { message: { role: "tool", content: "ignored" } }, { message: { role: "user", content: "  " } },
  ];
  writeFileSync(io.path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\nnot-json\n");
  const expected = parseTranscript(io.path);
  const result = await capture.captureTranscript(input);
  expect(expected.map(m => [m.role, m.content])).toEqual([["tool", "Skill"], ["tool", "[tool error]\nbefore\u0000after"], ["assistant", "first\nsecond"]]);
  expect(result?.records.map(m => [m.role, m.content])).toEqual(expected.map(m => [m.role, m.content.replaceAll("\u0000", "\uFFFD")]));
  expect(db.prepare("SELECT message_count FROM codex_ingest_cursors").get()).toEqual({ message_count: 3 });
  expect((await capture.captureTranscript(input))?.records).toEqual([]);
});

it("backfills late tool events from the persistent model index after the capture connection closes", async () => {
  const { input, capture } = fixture();
  const call = JSON.stringify({ message: { role: "assistant", model: "claude-model", content: [{ type: "tool_use", id: "old-call", name: "Read" }] } }) + "\n";
  writeFileSync(io.path, call + Array.from({ length: 100 }, (_, i) => line(`turn ${i}`)).join(""));
  await capture.captureTranscript(input);
  db.close();
  db = new DatabaseSync(join(dir, "db.sqlite"));
  const fresh = new SessionCapture(db, "proj", new ScrubEngine([], []));
  const parsed = vi.spyOn(JSON, "parse");
  const result = await fresh.captureTranscript(input);
  db.close();
  const events = new EventsDb(join(dir, "events.db"));
  try {
    events.insertToolCallEvents("session", [{ type: "read", category: "tool", data: "x", priority: 3 }], "PostToolUse", "old-call", "claude");
    parsed.mockClear();
    result?.backfillModels(events);
    expect(events.hasUnfilledModels("session", "claude")).toBe(false);
    expect(parsed.mock.calls.length).toBeLessThan(16);
  } finally {
    events.close();
    db = new DatabaseSync(join(dir, "db.sqlite"));
  }
});

it("invalidates the durable validation when stored content changes without changing its count", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one") + line("two"));
  await capture.captureTranscript(input);
  db.exec("UPDATE messages SET content = 'damaged' WHERE seq = 0");
  appendFileSync(io.path, line("tail"));
  await expect(capture.captureTranscript(input)).rejects.toThrow("--rebuild");
  expect(await capture.conversationStore.getSessionMessageCount("session")).toBe(2);
});

it("keeps a Claude cursor session eligible for rebuild when its parser shape becomes unknown", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one"));
  await capture.captureTranscript(input);
  db.exec("UPDATE conversations SET parser_shape = NULL");
  expect(claudeRebuildCandidateIds(db)).toEqual(["session"]);
});

it("keeps the cursor resumable when compaction appends an excluded event row", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one") + line("two"));
  const first = await capture.captureTranscript(input);
  const event = await capture.conversationStore.createMessage({ conversationId: first!.conversationId, seq: 2, role: "system", content: "compacted", tokenCount: 1 });
  await capture.conversationStore.createMessageParts(event.messageId, [{ sessionId: "session", partType: "compaction", ordinal: 0 }]);
  appendFileSync(io.path, line("tail"));
  const parsed = vi.spyOn(JSON, "parse");
  const rows = vi.spyOn(capture.conversationStore, "getSessionMessages");
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["tail"]);
  expect(parsed.mock.calls.length).toBeLessThan(16);
  expect(rows).not.toHaveBeenCalled();
  expect(db.prepare("SELECT message_count FROM codex_ingest_cursors").get()).toEqual({ message_count: 3 });
  expect(claudeRebuildCandidateIds(db)).toEqual(["session"]);
});

it("rolls back messages, cursor, and model index together if checkpoint metadata cannot be written", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one"));
  await capture.captureTranscript(input);
  const cursor = db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get();
  const call = JSON.stringify({ message: { role: "assistant", model: "new-model", content: [{ type: "tool_use", id: "new-call", name: "Read" }] } }) + "\n";
  appendFileSync(io.path, call);
  db.exec(`CREATE TRIGGER reject_model BEFORE INSERT ON claude_tool_use_models
    WHEN NEW.tool_use_id = 'new-call' BEGIN SELECT RAISE(ABORT, 'model failure'); END`);
  await expect(capture.captureTranscript(input)).rejects.toThrow("model failure");
  expect(await capture.conversationStore.getSessionMessageCount("session")).toBe(1);
  expect(db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get()).toEqual(cursor);
  expect(db.prepare("SELECT model FROM claude_tool_use_models").all()).toEqual([]);
  db.exec("DROP TRIGGER reject_model");
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["Read"]);
  expect(db.prepare("SELECT model FROM claude_tool_use_models").get()).toEqual({ model: "new-model" });
});

it("includes a valid unterminated record in live capture and import, then validates recovery on growth", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one"));
  await capture.captureTranscript(input);
  appendFileSync(io.path, line("two").trimEnd());
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["two"]);
  expect((await capture.captureTranscript({ ...input, source: "import" }))?.records).toEqual([]);
  expect(db.prepare("SELECT message_count, record_boundary FROM codex_ingest_cursors").get()).toEqual({ message_count: 2, record_boundary: 0 });
  appendFileSync(io.path, "\n" + line("three"));
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["three"]);
});

it("does not consume an incomplete trailing record during an import", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one"));
  await capture.captureTranscript(input);
  const cursor = db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get();
  const tail = line("two");
  appendFileSync(io.path, tail.slice(0, -4));
  expect((await capture.captureTranscript({ ...input, source: "import" }))?.records).toEqual([]);
  expect(db.prepare("SELECT byte_offset, message_count FROM codex_ingest_cursors").get()).toEqual(cursor);
  appendFileSync(io.path, tail.slice(-4));
  expect((await capture.captureTranscript({ ...input, source: "import" }))?.records.map(r => r.content)).toEqual(["two"]);
});

it("persists only a redaction-rule digest, including when a rule contains a literal credential", async () => {
  const { input } = fixture();
  const secret = "synthetic-credential";
  const capture = new SessionCapture(db, "proj", new ScrubEngine([secret], []));
  writeFileSync(io.path, line(`before ${secret} after`));
  expect((await capture.captureTranscript(input))?.records.map(r => r.content)).toEqual(["before [REDACTED] after"]);
  const cursor = db.prepare("SELECT claude_redaction_key FROM codex_ingest_cursors").get() as { claude_redaction_key: string };
  expect(cursor.claude_redaction_key).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(db.prepare("SELECT * FROM codex_ingest_cursors").all())).not.toContain(secret);
});

it("revalidates the stored prefix when built-in redaction rules change", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one"));
  await capture.captureTranscript(input);
  NATIVE_PATTERNS.push("opaque-[0-9]+");
  try {
    const updated = new SessionCapture(db, "proj", new ScrubEngine([], []));
    const rows = vi.spyOn(updated.conversationStore, "getSessionMessages");
    expect((await updated.captureTranscript(input))?.records).toEqual([]);
    expect(rows).toHaveBeenCalledExactlyOnceWith("session", 0);
  } finally {
    NATIVE_PATTERNS.pop();
  }
});

it("keeps a validated session guarded when its transcript path changes", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one") + line("two"));
  await capture.captureTranscript(input);
  // Another transcript whose prefix differs from the stored history, plus a tail.
  mkdirSync(join(dir, "moved"));
  const other = join(dir, "moved", "session.jsonl");
  writeFileSync(other, line("different") + line("two") + line("tail"));
  await expect(capture.captureTranscript({ ...input, transcriptPath: other })).rejects.toThrow("--rebuild");
  expect(await capture.conversationStore.getSessionMessageCount("session")).toBe(2);
});

it("keeps a validated session guarded when its database is copied", async () => {
  const { input, capture } = fixture();
  writeFileSync(io.path, line("one") + line("two"));
  await capture.captureTranscript(input);
  db.close();
  const copy = join(dir, "copy.sqlite");
  copyFileSync(join(dir, "db.sqlite"), copy);
  db = new DatabaseSync(copy);
  // The same path now holds a different prefix plus a tail.
  writeFileSync(io.path, line("different") + line("two") + line("tail"));
  const reopened = new SessionCapture(db, "proj", new ScrubEngine([], []));
  await expect(reopened.captureTranscript(input)).rejects.toThrow("--rebuild");
  expect(await reopened.conversationStore.getSessionMessageCount("session")).toBe(2);
});
