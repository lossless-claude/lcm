import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { SessionCapture } from "../src/capture.js";
import { ScrubEngine } from "../src/scrub.js";
import { backfillSessionEventTimes } from "../src/event-time-backfill.js";
import { parseTranscript } from "../src/transcript.js";
import { parseCodexTranscript } from "../src/codex-transcript.js";
import { parseOmpTranscript } from "../src/omp-transcript.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { RetrievalEngine } from "../src/retrieval.js";

type Client = "claude" | "codex" | "omp";
function fixture(client: Client, cwd: string, input: unknown = { command: "printf searchable_command", cmd: "printf searchable_command" }) {
  if (client === "claude") return {
    header: "",
    call: { message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Bash", input }] } },
    result: { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", is_error: true, content: "Exit code 9\nfailed" }] } },
  };
  if (client === "codex") return {
    header: JSON.stringify({ type: "session_meta", payload: { id: "session", cwd } }) + "\n",
    call: { type: "response_item", payload: { type: "function_call", call_id: "call", name: "exec_command", arguments: JSON.stringify(input) } },
    result: { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "Process exited with code 9\nFinal output:\nfailed" } },
  };
  return {
    header: JSON.stringify({ type: "session", id: "session", cwd }) + "\n",
    call: { type: "message", id: "e1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: input }] } },
    result: { type: "message", id: "e2", parentId: "e1", message: { role: "toolResult", toolCallId: "call", isError: true, content: [{ type: "text", text: "Command exited with code 9" }] } },
  };
}
const line = (value: unknown) => JSON.stringify(value) + "\n";

describe("tool-call capture and repair", () => {
  let db: DatabaseSync, dir: string, path: string, scrubber: ScrubEngine, capture: SessionCapture;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lcm-call-fixture-"));
    path = join(dir, "session.jsonl");
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db);
    scrubber = new ScrubEngine([], ["SECRET_EXAMPLE"]);
    capture = new SessionCapture(db, "project", scrubber);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = () => db.prepare("SELECT * FROM transcript_tool_calls ORDER BY call_id").all() as Array<Record<string, unknown>>;
  const input = (client: Client) => ({ cwd: dir, transcriptPath: path, sessionId: "session", client });

  it.each(["claude", "codex", "omp"] as const)("updates a %s call when its result arrives in later bytes, without changing message rows", async client => {
    const f = fixture(client, dir);
    writeFileSync(path, f.header + line(f.call));
    const first = await capture.captureTranscript(input(client));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ message_id: first!.records[0].messageId, outcome: "unknown", harness_error: null });
    appendFileSync(path, line(f.result));
    const second = await capture.captureTranscript(input(client));
    expect(second!.records).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ message_id: first!.records[0].messageId, outcome: "failed", exit_code: 9, harness_error: client === "codex" ? null : 1 });
    expect((await capture.captureTranscript(input(client)))!.records).toHaveLength(0);
    expect(calls()).toHaveLength(1);
    const parsed = client === "claude" ? parseTranscript(path) : client === "codex" ? parseCodexTranscript(path) : parseOmpTranscript(path);
    expect((await capture.conversationStore.getSessionMessages("session")).map(({ role, content, tokenCount }) => ({ role, content, tokenCount })))
      .toEqual(parsed.map(({ role, content, tokenCount }) => ({ role, content, tokenCount })));
  });

  it.each(["claude", "codex", "omp"] as const)("scrubs %s commands before the UTF-8 2 KB cap and marks truncation", async client => {
    const command = "printf SECRET_EXAMPLE " + "界".repeat(1200);
    const f = fixture(client, dir, { command, cmd: command });
    writeFileSync(path, f.header + line(f.call));
    await capture.captureTranscript(input(client));
    const call = calls()[0];
    expect(call.input).toContain("[REDACTED]");
    expect(call.input).not.toContain("SECRET_EXAMPLE");
    expect(call.input).not.toContain("�");
    expect(Buffer.byteLength(String(call.input))).toBeLessThanOrEqual(2048);
    expect(call.input).toMatch(/\[truncated\]$/);
    expect(call.truncated).toBe(1);
    expect(db.prepare("SELECT content FROM messages").get()).toEqual({ content: client === "claude" ? "Bash" : client === "codex" ? "exec_command" : "bash" });
  });

  it.each(["claude", "codex", "omp"] as const)("backfills %s calls beside existing messages even when event times are already known", async client => {
    const f = fixture(client, dir);
    writeFileSync(path, f.header + line(f.call) + line(f.result));
    const parsed = client === "claude" ? parseTranscript(path) : client === "codex" ? parseCodexTranscript(path) : parseOmpTranscript(path);
    await capture.write({ sessionId: "session", messages: parsed.map(message => ({ ...message, eventAt: "2026-01-01T00:00:00Z" })) });
    const before = db.prepare("SELECT * FROM messages ORDER BY message_id").all();
    expect(calls()).toEqual([]);
    await backfillSessionEventTimes(db, input(client), scrubber);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ outcome: "failed", exit_code: 9, input: "printf searchable_command" });
    expect(db.prepare("SELECT * FROM messages ORDER BY message_id").all()).toEqual(before);
    await backfillSessionEventTimes(db, input(client), scrubber);
    expect(calls()).toHaveLength(1);
  });

  it("does not attribute an unaligned historical call to an unrelated stored message", async () => {
    const f = fixture("claude", dir);
    writeFileSync(path, line(f.call));
    await capture.write({ sessionId: "session", messages: [{ role: "user", content: "different", tokenCount: 3 }] });
    await backfillSessionEventTimes(db, input("claude"), scrubber);
    expect(calls()).toEqual([]);
  });

  it.each(["claude", "codex", "omp"] as const)("excludes %s worker calls from capture and backfill", async client => {
    const f = fixture(client, dir);
    writeFileSync(path, f.header + line(f.call));
    db.prepare("INSERT INTO summarize_workers (session_id, cwd, client, state) VALUES (?, ?, ?, 'active')").run("session", dir, client);
    await capture.captureTranscript(input(client));
    await backfillSessionEventTimes(db, input(client), scrubber);
    expect(calls()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  it("full-text grep finds a stored command and joins the call to its message and summaries", async () => {
    const f = fixture("claude", dir);
    writeFileSync(path, line(f.call));
    const written = await capture.captureTranscript(input("claude"));
    const engine = new RetrievalEngine(capture.conversationStore, capture.summaryStore);
    const result = await engine.grep({ query: "searchable_command", mode: "full_text", scope: "messages" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ messageId: written!.records[0].messageId, snippet: expect.stringContaining("searchable_command") });
    expect((await engine.grep({ query: "searchable_command", mode: "full_text", scope: "messages", conversationId: 999 })).messages).toEqual([]);
  });

  it.each(["claude", "omp"] as const)("updates an empty %s result during capture and historical backfill", async client => {
    const f = fixture(client, dir);
    const result = client === "claude"
      ? { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", is_error: false, content: "" }] } }
      : { type: "message", id: "e2", parentId: "e1", message: { role: "toolResult", toolCallId: "call", isError: false, content: [] } };
    writeFileSync(path, f.header + line(f.call));
    await capture.captureTranscript(input(client));
    appendFileSync(path, line(result));
    expect((await capture.captureTranscript(input(client)))!.records).toHaveLength(0);
    expect(calls()[0]).toMatchObject({ outcome: "succeeded", harness_error: 0 });
    db.exec("DELETE FROM transcript_tool_calls");
    await backfillSessionEventTimes(db, input(client), scrubber);
    expect(calls()[0]).toMatchObject({ outcome: "succeeded", harness_error: 0 });
  });

  it("joins multiple calls in a mixed Claude prose row to that same stored message", async () => {
    writeFileSync(path, line({ message: { role: "assistant", content: [
      { type: "text", text: "Working." },
      { type: "tool_use", id: "a", name: "Bash", input: { command: "printf first_command" } },
      { type: "tool_use", id: "b", name: "Bash", input: { command: "printf second_command" } },
    ] } }));
    const written = await capture.captureTranscript(input("claude"));
    expect(written!.records.map(record => record.content)).toEqual(["Working."]);
    expect(calls().map(call => call.message_id)).toEqual([written!.records[0].messageId, written!.records[0].messageId]);
    for (const query of ["first_command", "second_command"]) {
      expect(capture.conversationStore.searchMessagesSync({ query, mode: "full_text" })).toHaveLength(1);
    }
  });

  it("backfill spans pages without losing a result that answers an earlier page's call", async () => {
    const f = fixture("claude", dir);
    const prose = Array.from({ length: 256 }, (_, index) => ({ message: { role: "user", content: "message " + index } }));
    writeFileSync(path, [f.call, ...prose, f.result].map(line).join(""));
    await capture.write({ sessionId: "session", messages: parseTranscript(path) });
    await backfillSessionEventTimes(db, input("claude"), scrubber);
    expect(calls()[0]).toMatchObject({ outcome: "failed", exit_code: 9 });
  });

  it("a refusal without block evidence is blocked for a shell command and unknown for any other tool", async () => {
    const refusal = "This guard refuses the call";
    writeFileSync(path, [
      { message: { role: "assistant", content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "printf x" } }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shell", is_error: true, content: refusal }] } },
      { message: { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "missing.ts" } }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read", is_error: true, content: "File does not exist." }] } },
    ].map(line).join(""));
    await capture.captureTranscript(input("claude"));
    expect(Object.fromEntries(calls().map(call => [call.call_id, [call.outcome, call.harness_error]])))
      .toEqual({ shell: ["blocked", 1], read: ["unknown", 1] });
  });

  it("a cut-content repair keeps the message's call inputs searchable", async () => {
    const f = fixture("codex", dir);
    writeFileSync(path, f.header + line(f.call));
    await capture.captureTranscript(input("codex"));
    const messageId = Number(calls()[0].message_id);
    const stored = String((db.prepare("SELECT content FROM messages WHERE message_id = ?").get(messageId) as { content: string }).content);
    expect(capture.conversationStore.repairCutMessageContent([{ messageId, storedContent: stored, content: stored }])).toBe(1);
    expect(capture.conversationStore.searchMessagesSync({ query: "searchable_command", mode: "full_text" })).toHaveLength(1);
  });

  it("scrubs and caps MCP JSON before storing it", async () => {
    writeFileSync(path, line({ message: { role: "assistant", content: [{ type: "tool_use", id: "mcp", name: "mcp__service__query", input: { token: "SECRET_EXAMPLE", value: "x".repeat(3000) } }] } }));
    await capture.captureTranscript(input("claude"));
    expect(calls()[0]).toMatchObject({ truncated: 1, input: expect.stringContaining("[REDACTED]") });
    expect(Buffer.byteLength(String(calls()[0].input))).toBeLessThanOrEqual(2048);
  });
});

describe("tool-call search fallback", () => {
  it("finds a command with FTS disabled", async () => {
    const db = new DatabaseSync(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "lcm-call-fallback-"));
    try {
      runLcmMigrations(db, { fts5Available: false });
      const capture = new SessionCapture(db, "project", new ScrubEngine([], []));
      const path = join(dir, "session.jsonl");
      writeFileSync(path, line(fixture("claude", dir).call));
      await capture.captureTranscript({ cwd: dir, transcriptPath: path, sessionId: "session" });
      expect(new ConversationStore(db, { fts5Available: false }).searchMessagesSync({ query: "searchable_command", mode: "full_text" }))
        .toHaveLength(1);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

it("decodes Codex MCP JSON escapes before secret redaction", async () => {
  const db = new DatabaseSync(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "lcm-mcp-escape-"));
  try {
    runLcmMigrations(db);
    const path = join(dir, "session.jsonl");
    const escapedArguments = '{"token":"\\u0053ECRET_EXAMPLE"}';
    writeFileSync(path, line({ type: "session_meta", payload: { id: "session", cwd: dir } }) +
      line({ type: "response_item", payload: { type: "function_call", call_id: "call", name: "mcp__service__query", arguments: escapedArguments } }));
    const capture = new SessionCapture(db, "project", new ScrubEngine([], ["SECRET_EXAMPLE"]));
    await capture.captureTranscript({ cwd: dir, transcriptPath: path, sessionId: "session", client: "codex" });
    expect(db.prepare("SELECT input FROM transcript_tool_calls").get()).toEqual({ input: '{"token":"[REDACTED]"}' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps a scrubbed first line beside a blocked stored call", async () => {
  const db = new DatabaseSync(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "lcm-block-reason-"));
  try {
    runLcmMigrations(db);
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      { message: { role: "assistant", content: [{ type: "tool_use", id: "blocked", name: "Bash", input: { command: "npm install" } }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "blocked", is_error: true,
        content: "PreToolUse:Bash hook error: SECRET_EXAMPLE /tmp/cache\nprivate second line" }] } },
    ].map(line).join(""));
    await new SessionCapture(db, "project", new ScrubEngine([], ["SECRET_EXAMPLE"]))
      .captureTranscript({ cwd: dir, transcriptPath: path, sessionId: "session" });
    const call = db.prepare("SELECT * FROM transcript_tool_calls").get();
    expect(call).toMatchObject({ outcome: "blocked", block_reason: "PreToolUse:Bash hook error: [REDACTED] /tmp/cache" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
