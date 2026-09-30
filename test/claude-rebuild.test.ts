import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { backupProjectDatabase, claudeRebuildCandidateIds, compactedSessionIds, planSessionRebuild } from "../src/claude-rebuild.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ScrubEngine } from "../src/scrub.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { TranscriptSourceError } from "../src/transcript-source.js";
import { CLAUDE_PARSER_SHAPE, parseTranscript } from "../src/transcript.js";

/**
 * Before compaction stopped counting its own event rows, a Claude capture after a compaction
 * skipped one transcript message per event row, and the first capture after the fix stored the
 * last messages again. The guard stops further appends to such a history; the rebuild replaces
 * it with the transcript, keeping the conversation row and promoted memory.
 */

const sessionId = "claude-615";
const otherSession = "claude-other";
type Turn = [role: "user" | "assistant", text: string];
const transcriptTurns: Turn[] = [
  ["user", "q1"], ["assistant", "r1"], ["user", "q2"], ["assistant", "r2"], ["user", "q3"], ["assistant", "r3"],
];
/** q2 skipped by a capture after the compaction, q3 stored again by the first capture after the fix. */
const damagedTurns: Turn[] = [
  ["user", "q1"], ["assistant", "r1"], ["assistant", "r2"], ["user", "q3"], ["user", "q3"], ["assistant", "r3"],
];

let dir: string;
let dbPath: string;
let db: DatabaseSync;
let capture: SessionCapture;
const identity = (text: string) => text;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcm-claude-rebuild-"));
  dbPath = join(dir, "db.sqlite");
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runLcmMigrations(db);
  capture = new SessionCapture(db, "proj", new ScrubEngine([], []));
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function transcript(turns: Turn[], name = `${sessionId}.jsonl`): string {
  const path = join(dir, name);
  writeFileSync(path, turns.map(([role, text]) => JSON.stringify({ message: { role, content: text } })).join("\n") + "\n");
  return path;
}

function mixedToolShapeTranscript(): string {
  const entries = [
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
    { role: "user", content: [{ type: "tool_result", is_error: true, content: "missing file" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "Glob" }] },
    { role: "user", content: [{ type: "tool_result", content: "found files" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
    { role: "user", content: [{ type: "tool_result", content: "read result" }] },
    { role: "assistant", content: "answer" },
    { role: "assistant", content: [{ type: "tool_use", name: "StructuredOutput" }] },
    { role: "user", content: [{ type: "tool_result", content: "ack" }] },
  ];
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, entries.map((message) => JSON.stringify({ message })).join("\n") + "\n");
  return path;
}

function preRoleTaggingTranscript(): string {
  const path = join(dir, `${sessionId}.jsonl`);
  const entries = [
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
    { role: "user", content: [{ type: "tool_result", is_error: true, content: "missing file" }] },
    { role: "assistant", content: "answer" },
  ];
  writeFileSync(path, entries.map((message) => JSON.stringify({ message })).join("\n") + "\n");
  return path;
}

async function storePreRoleTagging(): Promise<string> {
  const path = preRoleTaggingTranscript();
  const oldRows = [
    { role: "user", content: "question", tokenCount: 2 },
    { role: "user", content: "missing file", tokenCount: 3 },
    { role: "assistant", content: "answer", tokenCount: 2 },
  ];
  expect(parseTranscript(path, "legacy").map((m) => m.content)).toEqual(oldRows.map((m) => m.content));
  await capture.write({ sessionId, messages: oldRows });
  db.prepare("UPDATE conversations SET role_tagging = NULL WHERE session_id = ?").run(sessionId);
  writeFileSync(path, `${JSON.stringify({ message: { role: "user", content: "next" } })}\n`, { flag: "a" });
  return path;
}

async function storeMixedToolShape(path: string): Promise<void> {
  const legacy = parseTranscript(path, "legacy");
  const current = parseTranscript(path);
  expect(legacy.map((m) => m.content)).toEqual(["question", "missing file", "found files", "read result", "answer", "ack"]);
  expect(current.map((m) => m.content).at(-4)).toBe("read result");
  const written = await capture.write({ sessionId, messages: legacy, parserShape: CLAUDE_PARSER_SHAPE });
  await compact(written.conversationId);
  await capture.write({ sessionId, messages: current.slice(legacy.length), sourceOffset: legacy.length, parserShape: CLAUDE_PARSER_SHAPE });
}

/** Stores turns as a Claude capture by today's parser would. */
async function store(turns: Turn[], session = sessionId): Promise<number> {
  const written = await capture.write({
    sessionId: session,
    messages: turns.map(([role, content]) => ({ role, content, tokenCount: 1 })),
    parserShape: CLAUDE_PARSER_SHAPE,
  });
  return written.conversationId;
}

/** The rows one compaction pass leaves: a leaf over the first two context items, a condensed parent, and the event row. */
async function compact(conversationId: number, session = sessionId): Promise<void> {
  const summaries = new SummaryStore(db);
  const messages = new ConversationStore(db);
  const items = await summaries.getContextItems(conversationId);
  const leafId = `leaf-${conversationId}`;
  await summaries.insertSummary({ summaryId: leafId, conversationId, kind: "leaf", content: `leaf of ${session}`, tokenCount: 1 });
  await summaries.linkSummaryToMessages(leafId, items.slice(0, 2).map((item) => item.messageId!));
  await summaries.replaceContextRangeWithSummary({
    conversationId, startOrdinal: items[0].ordinal, endOrdinal: items[1].ordinal, summaryId: leafId,
  });
  await summaries.insertSummary({ summaryId: `condensed-${conversationId}`, conversationId, kind: "condensed", depth: 1, content: `condensed of ${session}`, tokenCount: 1 });
  await summaries.linkSummaryToParents(`condensed-${conversationId}`, [leafId]);
  const event = await messages.createMessage({
    conversationId, seq: (await messages.getMaxSeq(conversationId)) + 1,
    role: "system", content: "LCM compaction leaf pass (normal): 100 -> 10", tokenCount: 1,
  });
  await messages.createMessageParts(event.messageId, [{ sessionId: session, partType: "compaction", ordinal: 0 }]);
}

const transcriptMessages = (session = sessionId) =>
  (db.prepare(
    `SELECT m.role, m.content FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE c.session_id = ? AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
     ORDER BY m.seq`,
  ).all(session) as Array<{ role: string; content: string }>).map(({ role, content }) => [role, content]);
const count = (sql: string, ...params: Array<string | number>) => (db.prepare(sql).get(...params) as { n: number }).n;

describe("the capture guard", () => {
  it("verifies an unstamped prefix, captures its tail, and stamps the session", async () => {
    const path = transcript(transcriptTurns.slice(0, 3));
    await capture.write({ sessionId, messages: parseTranscript(path).slice(0, 2), parserShape: null });

    expect((await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path }))?.records.map((row) => row.content))
      .toEqual(["q2"]);
    expect(transcriptMessages()).toEqual(transcriptTurns.slice(0, 3));
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: "claude-v4" });
  });

  it("stalls an unstamped legacy prefix followed by current-shape rows", async () => {
    const path = mixedToolShapeTranscript();
    const legacy = parseTranscript(path, "legacy");
    const current = parseTranscript(path);
    await capture.write({ sessionId, messages: [...legacy.slice(0, 4), ...current.slice(-2)], parserShape: null });
    const before = transcriptMessages();

    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("--rebuild");
    expect(transcriptMessages()).toEqual(before);
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: null });
  });

  it("verifies and restamps a matching history with an older shape", async () => {
    const path = transcript(transcriptTurns.slice(0, 3));
    await capture.write({ sessionId, messages: parseTranscript(path).slice(0, 2), parserShape: "claude-old" });

    expect((await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path }))?.records.map((row) => row.content))
      .toEqual(["q2"]);
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: "claude-v4" });
  });

  it("leaves a conversation opened without a known shape unstamped", async () => {
    // /compact's no-ingest fallback opens the row for any client.
    await capture.write({ sessionId, messages: [] });
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: null });
  });

  it("selects rebuild candidates from a database migrated before the stamp existed", async () => {
    await capture.write({ sessionId, messages: [], parserShape: "claude-v2" });
    db.exec("ALTER TABLE conversations DROP COLUMN parser_shape");
    expect(claudeRebuildCandidateIds(db)).toEqual([sessionId]);
  });

  it("invalidates an existing Claude stamp when structured ingestion appends", async () => {
    const path = transcript(transcriptTurns.slice(0, 2));
    await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    await capture.write({
      sessionId, messages: [...parseTranscript(path), { role: "user", content: "structured only", tokenCount: 1 }],
      parserShape: "structured",
    });
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: "structured" });

    transcript(transcriptTurns.slice(0, 3));
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("--rebuild");
  });

  it("stalls a second capture when the stored Claude parser shape has changed", async () => {
    const path = mixedToolShapeTranscript();
    const input = { sessionId, cwd: dir, transcriptPath: path };
    const legacy = parseTranscript(path, "legacy");
    await capture.write({ sessionId, messages: legacy });
    // Slicing today's parse at the old count would repeat an already stored tool result.
    expect(parseTranscript(path).slice(legacy.length)[0].content).toBe("read result");
    const before = transcriptMessages();
    db.prepare("UPDATE conversations SET parser_shape = 'claude-before-tool-rows' WHERE session_id = ?").run(sessionId);

    writeFileSync(path, `${JSON.stringify({ message: { role: "user", content: "next" } })}\n`, { flag: "a" });
    await expect(capture.captureTranscript(input)).rejects.toThrow("--rebuild");
    expect(transcriptMessages()).toEqual(before);
  });

  it("continues a second capture when the parser stamp matches", async () => {
    const path = transcript(transcriptTurns.slice(0, 2));
    const input = { sessionId, cwd: dir, transcriptPath: path };
    await capture.captureTranscript(input);
    transcript(transcriptTurns.slice(0, 3));
    expect((await capture.captureTranscript(input))?.records.map((row) => row.content)).toEqual(["q2"]);
    expect(transcriptMessages()).toEqual(transcriptTurns.slice(0, 3));
  });

  it("accepts a compacted message stored cut at its first NUL", async () => {
    const path = transcript([["user", "first"], ["assistant", "before\u0000after"]]);
    const conversationId = await store([["user", "first"], ["assistant", "before"]]);
    db.prepare("UPDATE messages SET content = ? WHERE conversation_id = ? AND role = 'assistant'")
      .run("before\u0000after", conversationId);
    expect(transcriptMessages()[1]).toEqual(["assistant", "before"]);
    await compact(conversationId);
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).resolves.toBeDefined();
  });

  it("still rejects a damaged prefix when the transcript contains a NUL elsewhere", async () => {
    const path = transcript([["user", "first"], ["assistant", "before\u0000after"]]);
    await compact(await store([["user", "first"], ["assistant", "wrong"]]));
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("--rebuild");
  });

  it("stalls a compacted history with a legacy prefix and a current-shape tail", async () => {
    const path = mixedToolShapeTranscript();
    await storeMixedToolShape(path);
    const before = transcriptMessages();

    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("--rebuild");
    expect(transcriptMessages()).toEqual(before);
  });

  it("validates a long compacted prefix once, then loads only the newly stored overlap", async () => {
    const turns: Turn[] = Array.from({ length: 5_000 }, (_, i) => [i % 2 ? "assistant" : "user", `turn ${i}`]);
    await compact(await store(turns));
    const reads = vi.spyOn(ConversationStore.prototype, "getSessionMessages");
    const path = transcript([...turns, ["user", "next"]]);
    await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect((await reads.mock.results[0].value).length).toBe(5_000);
    reads.mockClear();

    transcript([...turns, ["user", "next"], ["assistant", "answer"]]);
    // Routes release their connection and construct a fresh capture and scrubber per request.
    db.close();
    db = new DatabaseSync(dbPath);
    const next = new SessionCapture(db, "proj", new ScrubEngine([], []));
    const result = await next.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(result?.records.map((r) => r.content)).toEqual(["answer"]);
    expect(reads).toHaveBeenCalledExactlyOnceWith(sessionId, 5_000);
    expect((await reads.mock.results[0].value).length).toBe(1);
  });

  it.each(["stored content", "transcript prefix", "conversation", "redaction rules", "path", "count decrease", "database replacement"])(
    "revalidates the full prefix after a change to %s", async (change) => {
      await compact(await store(transcriptTurns));
      let path = transcript(transcriptTurns);
      await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
      const reads = vi.spyOn(ConversationStore.prototype, "getSessionMessages");
      if (change === "stored content") db.exec("UPDATE messages SET content = 'damaged' WHERE seq = 0");
      if (change === "transcript prefix") transcript([["user", "rewritten"], ...transcriptTurns.slice(1)]);
      if (change === "conversation") db.exec("UPDATE conversations SET created_at = '2020-01-01 00:00:00'");
      if (change === "redaction rules") capture = new SessionCapture(db, "proj", new ScrubEngine(["q1"], []));
      if (change === "path") path = transcript(transcriptTurns, "replacement.jsonl");
      if (change === "count decrease") {
        db.exec("DELETE FROM context_items WHERE message_id IN (SELECT message_id FROM messages WHERE seq = 5); DELETE FROM messages WHERE seq = 5");
        transcript(transcriptTurns.slice(0, -1));
      }
      if (change === "database replacement") {
        db.close();
        copyFileSync(dbPath, `${dbPath}.replacement`);
        renameSync(`${dbPath}.replacement`, dbPath);
        db = new DatabaseSync(dbPath);
        capture = new SessionCapture(db, "proj", new ScrubEngine([], []));
      }
      const result = capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
      if (change === "stored content" || change === "transcript prefix") {
        await expect(result).rejects.toThrow("--rebuild");
      } else {
        await result;
      }
      expect(reads).toHaveBeenCalledExactlyOnceWith(sessionId, 0);
    },
  );

  it("still stalls when the newly stored overlap is damaged, without appending a tail", async () => {
    await compact(await store(transcriptTurns));
    const path = transcript(transcriptTurns);
    await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    await store([...transcriptTurns, ["user", "wrong tail"]]);
    transcript([...transcriptTurns, ["user", "right tail"], ["assistant", "new answer"]]);
    const before = transcriptMessages();
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("--rebuild");
    expect(transcriptMessages()).toEqual(before);
  });

  it("does not memoize the uncaptured tail when its write rolls back", async () => {
    await compact(await store(transcriptTurns));
    const path = transcript([...transcriptTurns, ["user", "next"]]);
    const write = vi.spyOn(ConversationStore.prototype, "createMessagesBulk").mockRejectedValueOnce(new Error("write failed"));
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("write failed");
    write.mockRestore();
    const result = await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(result?.records.map((r) => r.content)).toEqual(["next"]);
    expect(transcriptMessages()).toEqual([...transcriptTurns, ["user", "next"]]);
  });

  it("discards a warm memo when a rebuild reads the full transcript, even for an aligned session", async () => {
    await compact(await store(transcriptTurns));
    const path = transcript(transcriptTurns);
    const input = { sessionId, cwd: dir, transcriptPath: path };
    await capture.captureTranscript(input);
    expect((await capture.rebuildTranscript(input)).plan.kind).toBe("aligned");
    const reads = vi.spyOn(ConversationStore.prototype, "getSessionMessages");
    await capture.captureTranscript(input);
    expect(reads).toHaveBeenCalledExactlyOnceWith(sessionId, 0);
  });

  it("stalls a compacted session whose stored history is not the transcript's prefix, writing nothing", async () => {
    await compact(await store(damagedTurns));
    const path = transcript([...transcriptTurns, ["user", "q4"]]);
    const before = count("SELECT COUNT(*) AS n FROM messages");

    const read = capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    await expect(read).rejects.toThrow(TranscriptSourceError);
    await expect(read).rejects.toThrow("--rebuild");
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(before);
  });

  it("does not compare a session compaction never wrote into", async () => {
    await store([["user", "q1"], ["user", "not in the transcript"]]);
    const path = transcript(transcriptTurns);
    const result = await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(result?.records.map((r) => r.content)).toEqual(["q2", "r2", "q3", "r3"]);
  });

  it("does not compare a conversation an earlier transcript parser captured", async () => {
    await compact(await store(damagedTurns));
    db.exec("UPDATE conversations SET role_tagging = NULL");
    const path = transcript([...transcriptTurns, ["user", "q4"]]);
    const result = await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(result?.records.map((r) => r.content)).toEqual(["q4"]);
  });

  it("continues a compacted session whose history repeats itself legitimately", async () => {
    const repeats: Turn[] = [["user", "continue"], ["assistant", "ok"], ["user", "continue"], ["assistant", "ok"]];
    await compact(await store(repeats));
    const path = transcript([...repeats, ["user", "continue"]]);
    const result = await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(result?.records.map((r) => r.content)).toEqual(["continue"]);
  });

  it("continues a compacted session after a redaction pattern that matched in it is removed", async () => {
    const turns: Turn[] = [["user", "use tok-ABC123 here"], ["assistant", "ok"]];
    await new SessionCapture(db, "proj", new ScrubEngine(["tok-[A-Z0-9]+"], [])).write({
      sessionId, messages: turns.map(([role, content]) => ({ role, content, tokenCount: 1 })),
    });
    await compact((db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(sessionId) as { conversation_id: number }).conversation_id);
    expect(transcriptMessages()[0]).toEqual(["user", "use [REDACTED] here"]);
    const path = transcript([...turns, ["user", "q4"]]);
    const result = await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(result?.records.map((r) => r.content)).toEqual(["q4"]);
  });
});

describe("classifying a session for a rebuild", () => {
  const plan = async (turns: Turn[] | undefined) =>
    planSessionRebuild(db, sessionId, turns && parseTranscript(transcript(turns)), identity);

  it("repairs a pre-fix tool output cut at NUL and restores its full text", async () => {
    const path = join(dir, `${sessionId}.jsonl`);
    const messages = [
      { message: { role: "user", content: "first" } },
      { message: { role: "assistant", content: "answer" } },
      { message: { role: "user", content: [{ type: "tool_result", content: "before\u0000after" }] } },
    ];
    writeFileSync(path, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    const conversationId = await store([["user", "first"], ["assistant", "answer"]]);
    await capture.write({ sessionId, messages: [{ role: "tool", content: "before", tokenCount: 1 }], sourceOffset: 2 });
    db.prepare("UPDATE messages SET content = ? WHERE conversation_id = ? AND role = 'tool'")
      .run("before\u0000after", conversationId);
    expect(transcriptMessages()[2]).toEqual(["tool", "before"]);
    await compact(conversationId);
    const parsed = parseTranscript(path);
    expect(await planSessionRebuild(db, sessionId, parsed, identity)).toMatchObject({ kind: "repairable" });
    const rebuilt = await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(rebuilt).toMatchObject({ plan: { kind: "repairable" }, ingested: 3 });
    expect(transcriptMessages()).toEqual([["user", "first"], ["assistant", "answer"], ["tool", "before\uFFFDafter"]]);
  });

  it("classifies mixed tool-shape history as repairable and rebuilds today's parse", async () => {
    const path = mixedToolShapeTranscript();
    await storeMixedToolShape(path);
    const current = parseTranscript(path);
    const legacy = parseTranscript(path, "legacy");
    expect(transcriptMessages()).toEqual([...legacy, ...current.slice(legacy.length)].map((m) => [m.role, m.content]));
    expect(await planSessionRebuild(db, sessionId, current, identity, () => legacy)).toMatchObject({
      kind: "repairable", gaps: 5, extras: 5, leafSummaries: 1, condensedSummaries: 1,
    });

    const rebuilt = await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(rebuilt.plan.kind).toBe("repairable");
    expect(rebuilt.ingested).toBe(current.length);
    expect(transcriptMessages()).toEqual(current.map((message) => [message.role, message.content]));
  });

  it("reads the legacy shape only for a session that is not aligned", async () => {
    let legacyReads = 0;
    const legacy = () => { legacyReads++; return []; };
    await compact(await store(transcriptTurns.slice(0, 3)));
    expect(await planSessionRebuild(db, sessionId, parseTranscript(transcript(transcriptTurns)), identity, legacy))
      .toMatchObject({ kind: "aligned" });
    expect(legacyReads).toBe(0);
  });

  it("leaves mixed history ambiguous when a stored message is absent from both parses", async () => {
    const path = mixedToolShapeTranscript();
    await storeMixedToolShape(path);
    db.prepare("UPDATE messages SET content = 'only in storage' WHERE content = 'found files'").run();
    const before = transcriptMessages();
    const plan = await planSessionRebuild(db, sessionId, parseTranscript(path), identity, () => parseTranscript(path, "legacy"));
    expect(plan).toMatchObject({ kind: "ambiguous", reason: "1 stored messages are not in the transcript" });
    expect(await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path })).toMatchObject({
      plan: { kind: "ambiguous" }, ingested: 0,
    });
    expect(transcriptMessages()).toEqual(before);
  });

  it("repairs an untagged session grown after the parser change", async () => {
    const path = await storePreRoleTagging();
    const before = transcriptMessages();
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow("--rebuild");
    expect(transcriptMessages()).toEqual(before);
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: null });

    expect(await planSessionRebuild(db, sessionId, parseTranscript(path), identity, () => parseTranscript(path, "legacy")))
      .toMatchObject({ kind: "repairable" });
    expect(claudeRebuildCandidateIds(db)).toContain(sessionId);
    expect(await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path })).toMatchObject({
      plan: { kind: "repairable" }, ingested: parseTranscript(path).length,
    });
    expect(transcriptMessages()).toEqual(parseTranscript(path).map((m) => [m.role, m.content]));
    expect(db.prepare("SELECT parser_shape FROM conversations WHERE session_id = ?").get(sessionId))
      .toEqual({ parser_shape: CLAUDE_PARSER_SHAPE });
    await expect(capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path }))
      .resolves.toMatchObject({ records: [] });
  });

  it("leaves an untagged session that has not grown aligned, so a rebuild keeps its summaries", async () => {
    const path = preRoleTaggingTranscript();
    const legacy = parseTranscript(path, "legacy");
    await capture.write({ sessionId, messages: legacy });
    db.prepare("UPDATE conversations SET role_tagging = NULL WHERE session_id = ?").run(sessionId);
    const before = transcriptMessages();
    expect(await planSessionRebuild(db, sessionId, parseTranscript(path), identity, () => parseTranscript(path, "legacy")))
      .toMatchObject({ kind: "aligned" });
    expect(await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path })).toMatchObject({
      plan: { kind: "aligned" }, ingested: 0,
    });
    expect(transcriptMessages()).toEqual(before);
  });

  it("repairs an untagged session grown only by a tool call the older parse drops", async () => {
    const path = preRoleTaggingTranscript();
    const legacy = parseTranscript(path, "legacy");
    await capture.write({ sessionId, messages: legacy });
    db.prepare("UPDATE conversations SET role_tagging = NULL WHERE session_id = ?").run(sessionId);
    writeFileSync(path, `${JSON.stringify({
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_tail", name: "Bash", input: { command: "ls" } }] },
    })}\n`, { flag: "a" });
    expect(parseTranscript(path, "legacy")).toEqual(legacy);

    expect(await planSessionRebuild(db, sessionId, parseTranscript(path), identity, () => parseTranscript(path, "legacy")))
      .toMatchObject({ kind: "repairable" });
  });

  it("leaves an untagged session ambiguous when a stored row is in no parse", async () => {
    const path = await storePreRoleTagging();
    db.prepare("UPDATE messages SET content = 'only in storage' WHERE content = 'missing file'").run();
    const before = transcriptMessages();
    expect(await planSessionRebuild(db, sessionId, parseTranscript(path), identity, () => parseTranscript(path, "legacy")))
      .toMatchObject({ kind: "ambiguous", reason: "1 stored messages are not in the transcript" });
    expect(await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path })).toMatchObject({
      plan: { kind: "ambiguous" }, ingested: 0,
    });
    expect(transcriptMessages()).toEqual(before);
  });

  it("aligned: the stored history is a prefix of the transcript, an uncaptured tail included", async () => {
    await compact(await store(transcriptTurns.slice(0, 3)));
    expect(await plan(transcriptTurns)).toMatchObject({ kind: "aligned", gaps: 0, extras: 0 });
  });

  it("repairable: counts the skipped messages, the extra stored rows and the summaries a rebuild discards", async () => {
    await compact(await store(damagedTurns));
    const changes = count("SELECT total_changes() AS n");
    expect(await plan(transcriptTurns)).toMatchObject({
      kind: "repairable", gaps: 1, extras: 1, leafSummaries: 1, condensedSummaries: 1,
    });
    expect(count("SELECT total_changes() AS n")).toBe(changes);
  });

  it("repairable: a stored message redacted by a pattern since removed is still found in the transcript", async () => {
    const withSecret: Turn[] = [["user", "q1 tok-ABC123"], ...transcriptTurns.slice(1)];
    await compact(await store([["user", "q1 [REDACTED]"], ...damagedTurns.slice(1)]));
    expect(await plan(withSecret)).toMatchObject({ kind: "repairable", gaps: 1, extras: 1 });
  });

  it("unavailable: no transcript to rebuild from", async () => {
    await compact(await store(damagedTurns));
    expect(await plan(undefined)).toMatchObject({ kind: "unavailable" });
  });

  it("ambiguous: a stored message the transcript does not hold would be lost", async () => {
    await compact(await store([...damagedTurns, ["user", "only in the database"]]));
    expect(await plan(transcriptTurns)).toMatchObject({ kind: "ambiguous" });
  });

  it("repairable: an untagged conversation whose stored content is still in the transcript", async () => {
    await compact(await store(damagedTurns));
    db.exec("UPDATE conversations SET role_tagging = NULL");
    expect(await plan(transcriptTurns)).toMatchObject({ kind: "repairable" });
  });

  it("selects only sessions compaction wrote into", async () => {
    await compact(await store(damagedTurns));
    await store(transcriptTurns, otherSession);
    expect(compactedSessionIds(db)).toEqual([sessionId]);
  });
});

describe("rebuilding a session from its transcript", () => {
  async function damagedProject(): Promise<{ conversationId: number; otherId: number; path: string }> {
    const conversationId = await store(damagedTurns);
    await compact(conversationId);
    const otherId = await store(transcriptTurns, otherSession);
    await compact(otherId, otherSession);
    db.prepare("UPDATE conversations SET parent_session_id = 'parent', subagent_type = 'Explore' WHERE conversation_id = ?").run(conversationId);
    db.prepare("INSERT INTO large_files (file_id, conversation_id, storage_uri) VALUES ('file_1', ?, 'file:///x')").run(conversationId);
    db.prepare("INSERT INTO promoted (id, content, source_summary_id, project_id, session_id) VALUES ('p1', 'kept', ?, 'proj', ?)")
      .run(`leaf-${conversationId}`, sessionId);
    for (const session of [sessionId, otherSession]) {
      db.prepare("INSERT INTO replay_ledger (run_id, session_id, position, content_fingerprint) VALUES ('run', ?, 0, 'fp')").run(session);
    }
    return { conversationId, otherId, path: transcript(transcriptTurns) };
  }

  it("restores the transcript's order and drops what compaction and the damage left, for that conversation only", async () => {
    const { conversationId, otherId, path } = await damagedProject();
    const otherBefore = count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", otherId);

    const result = await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path });

    expect(result).toMatchObject({ plan: { kind: "repairable", gaps: 1, extras: 1 }, ingested: 6 });
    expect(transcriptMessages()).toEqual(transcriptTurns);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", conversationId)).toBe(6);
    expect(count("SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ?", conversationId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM summaries_fts WHERE summary_id LIKE ?", `%-${conversationId}`)).toBe(0);
    expect(count(
      "SELECT COUNT(*) AS n FROM messages_fts WHERE rowid NOT IN (SELECT message_id FROM messages)",
    )).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages_fts WHERE rowid IN (SELECT message_id FROM messages WHERE conversation_id = ?)", conversationId)).toBe(6);
    expect((db.prepare("SELECT item_type, message_id FROM context_items WHERE conversation_id = ? ORDER BY ordinal").all(conversationId) as Array<{ item_type: string }>)
      .map((row) => row.item_type)).toEqual(Array(6).fill("message"));
    expect(count("SELECT COUNT(*) AS n FROM replay_ledger WHERE session_id = ?", sessionId)).toBe(0);
    // Kept: the conversation row and its attribution, large files, promoted memory.
    expect(db.prepare("SELECT conversation_id, parent_session_id, subagent_type FROM conversations WHERE session_id = ?").all(sessionId))
      .toEqual([{ conversation_id: conversationId, parent_session_id: "parent", subagent_type: "Explore" }]);
    expect(count("SELECT COUNT(*) AS n FROM large_files WHERE conversation_id = ?", conversationId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM promoted WHERE id = 'p1'")).toBe(1);
    // The other session is untouched.
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", otherId)).toBe(otherBefore);
    expect(count("SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ?", otherId)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM replay_ledger WHERE session_id = ?", otherSession)).toBe(1);
  });

  it("leaves a session capture continues normally, and a second rebuild changes nothing", async () => {
    const { path } = await damagedProject();
    await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path });
    const changes = count("SELECT total_changes() AS n");

    expect(await capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path }))
      .toMatchObject({ plan: { kind: "aligned" }, ingested: 0 });
    expect(count("SELECT total_changes() AS n")).toBe(changes);
    expect(compactedSessionIds(db)).toEqual([otherSession]);

    writeFileSync(path, `${JSON.stringify({ message: { role: "user", content: "q4" } })}\n`, { flag: "a" });
    const next = await capture.captureTranscript({ sessionId, cwd: dir, transcriptPath: path });
    expect(next?.records.map((r) => r.content)).toEqual(["q4"]);
  });

  it("rolls the whole conversation back when a step fails", async () => {
    const { conversationId, otherId, path } = await damagedProject();
    // A summary of another conversation citing one of this conversation's messages: deleting
    // the message is refused, and the rebuild must not leave anything half-done.
    const cited = (db.prepare("SELECT message_id FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1").get(conversationId) as { message_id: number }).message_id;
    db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, 9)").run(`leaf-${otherId}`, cited);
    const snapshot = () => ({
      messages: transcriptMessages(),
      summaries: count("SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ?", conversationId),
      fts: count("SELECT COUNT(*) AS n FROM summaries_fts"),
      messageFts: count("SELECT COUNT(*) AS n FROM messages_fts"),
      context: count("SELECT COUNT(*) AS n FROM context_items WHERE conversation_id = ?", conversationId),
      ledger: count("SELECT COUNT(*) AS n FROM replay_ledger"),
    });
    const before = snapshot();

    await expect(capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("refuses a transcript that is not a Claude Code one", async () => {
    const { path } = await damagedProject();
    await expect(capture.rebuildTranscript({ sessionId, cwd: dir, transcriptPath: path, client: "codex" }))
      .rejects.toThrow(TranscriptSourceError);
  });
});

describe("backing a project database up before a rebuild", () => {
  it("writes a consistent copy that holds what the write-ahead log has not checkpointed", async () => {
    await compact(await store(damagedTurns));
    const target = await backupProjectDatabase(db, dbPath, new Date("2026-09-28T10:11:12.345Z"));
    expect(target).toBe(`${dbPath}.bak-rebuild-2026-09-28T10-11-12-345Z`);
    expect(existsSync(target)).toBe(true);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect((copy.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n)
        .toBe(count("SELECT COUNT(*) AS n FROM messages"));
    } finally {
      copy.close();
    }
  });

  it.skipIf(typeof sqlite.backup !== "function")("lets a timer run before a multi-step backup completes", async () => {
    db.exec("CREATE TABLE backup_payload (data BLOB)");
    db.prepare("INSERT INTO backup_payload (data) VALUES (?)").run(new Uint8Array(4 * 1024 * 1024));
    let timerFired = false;
    const timer = new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 0));

    await backupProjectDatabase(db, dbPath);

    expect(timerFired).toBe(true);
    await timer;
  });

  it("refuses to overwrite an earlier backup", async () => {
    const at = new Date("2026-09-28T10:11:12.345Z");
    await backupProjectDatabase(db, dbPath, at);
    await expect(backupProjectDatabase(db, dbPath, at)).rejects.toThrow();
  });

  it("keeps the completed copy and the oldest one, and reports each backup removed in between", async () => {
    const oldest = `${dbPath}.bak-rebuild-2026-09-24T00-00-00-000Z`;
    const older = `${dbPath}.bak-rebuild-2026-09-25T00-00-00-000Z`;
    const old = `${dbPath}.bak-rebuild-2026-09-26T00-00-00-000Z`;
    const unrelated = `${dbPath}.backup`;
    for (const path of [old, oldest, older, unrelated]) writeFileSync(path, "old");
    const removed: string[] = [];

    const latest = await backupProjectDatabase(db, dbPath, new Date("2026-09-28T00:00:00Z"), (path) => removed.push(path));

    expect(existsSync(latest)).toBe(true);
    expect(existsSync(oldest)).toBe(true);
    expect(removed).toEqual([older, old]);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("keeps a single earlier backup: it is the oldest", async () => {
    const earlier = `${dbPath}.bak-rebuild-2026-09-25T00-00-00-000Z`;
    writeFileSync(earlier, "old");
    const removed: string[] = [];
    await backupProjectDatabase(db, dbPath, new Date("2026-09-28T00:00:00Z"), (path) => removed.push(path));
    expect(removed).toEqual([]);
    expect(existsSync(earlier)).toBe(true);
  });

  it("leaves earlier backups when the new backup cannot be created", async () => {
    const old = `${dbPath}.bak-rebuild-2026-09-26T00-00-00-000Z`;
    writeFileSync(old, "old");
    const at = new Date("2026-09-28T00:00:00Z");
    writeFileSync(`${dbPath}.bak-rebuild-2026-09-28T00-00-00-000Z`, "collision");
    const removed: string[] = [];

    await expect(backupProjectDatabase(db, dbPath, at, (path) => removed.push(path))).rejects.toThrow();
    expect(existsSync(old)).toBe(true);
    expect(removed).toEqual([]);
  });

  it("leaves earlier backups when SQLite cannot copy the database", async () => {
    const old = `${dbPath}.bak-rebuild-2026-09-26T00-00-00-000Z`;
    writeFileSync(old, "old");
    const closed = new DatabaseSync(join(dir, "closed.sqlite"));
    closed.close();

    await expect(backupProjectDatabase(closed, dbPath, new Date("2026-09-28T00:00:00Z"))).rejects.toThrow();
    expect(existsSync(old)).toBe(true);
  });
});
