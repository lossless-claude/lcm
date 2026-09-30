import { CompactionEngine, compactEngineConfig } from "../src/compaction.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCodexTranscriptRecord } from "../src/codex-transcript.js";
import { parseClaudeTranscriptRecord } from "../src/transcript.js";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { WorkerStore } from "../src/store/worker-store.js";
import { SessionCapture } from "../src/capture.js";
import { ScrubEngine } from "../src/scrub.js";
import { PromotedStore } from "../src/db/promoted.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PARSER_SHAPE } from "../src/transcript.js";

const canary = "FOREIGN_WORKER_CONTENT_685";
const messages = [{ role: "user" as const, content: canary, tokenCount: 10, parts: [{ type: "text" as const, text: canary }] }];
describe("permanent worker exclusion", () => {
  let db: DatabaseSync;
  let capture: SessionCapture;
  let workers: WorkerStore;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { claudeProjectsDir: "/nonexistent" });
    capture = new SessionCapture(db, "project", new ScrubEngine([], []));
    workers = new WorkerStore(db);
  });
  afterEach(() => db.close());

  it("copied claims refuse new capture while preserving history outside a discovered worker directory", async () => {
    const old = await capture.write({ sessionId: "worker", messages });
    await capture.write({ sessionId: "ordinary", messages: [{ ...messages[0], content: "ordinary", parts: [] }] });
    const compacted = await new CompactionEngine(capture.conversationStore, capture.summaryStore,
      { ...compactEngineConfig({ env: {} }), freshTailCount: 0, leafMinFanout: 1 }).compact({
        conversationId: old.conversationId, tokenBudget: 100, force: true, summarize: async () => canary,
      });
    expect(compacted.actionTaken).toBe(true);
    expect(db.prepare("SELECT * FROM summaries").all()).toHaveLength(1);
    new PromotedStore(db).insert({ content: canary, projectId: "project", sessionId: "worker" });
    new PromotedStore(db).insert({ content: "unknown provenance", projectId: "project" });
    expect(db.prepare("SELECT * FROM promoted").all()).toHaveLength(2);
    expect(db.prepare("SELECT * FROM message_parts").all().length).toBeGreaterThan(0);
    const tables = ["messages", "message_parts", "summaries", "context_items", "messages_fts", "summaries_fts", "promoted", "promoted_fts"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const copied = [
      { message: { role: "assistant", content: [{ type: "tool_use", id: "cleanup", name: "lcm_summarize_claim", input: {} }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "cleanup", content: JSON.stringify({ job: { prompt: canary, system: "system" } }) }] } },
    ];
    await capture.write({ sessionId: "worker", messages: copied.map(record => parseClaudeTranscriptRecord(JSON.stringify(record)).message!) });
    expect(workers.live("worker", "/project", "claude")).toBe(false);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare("SELECT * FROM session_ingest_log WHERE session_id = 'worker'").get()).toBeDefined();
    expect((await capture.write({ sessionId: "worker", messages })).records).toEqual([]);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  });

  it("revokes the previous id on clear but permanently excludes resumed history and descendants", async () => {
    workers.register({ sessionId: "old", cwd: "/project", client: "claude", owner: "hook" });
    workers.register({ sessionId: "new", cwd: "/project", client: "claude", owner: "hook", replaceOwner: true });
    expect(workers.live("old", "/project", "claude")).toBe(false);
    expect(workers.live("new", "/project", "claude")).toBe(true);
    expect((await capture.write({ sessionId: "old", messages })).records).toEqual([]);
    expect((await capture.write({ sessionId: "child", messages, attribution: { parentSessionId: "old" } })).records).toEqual([]);
    expect((await capture.write({ sessionId: "grandchild", messages, transcriptPath: "/transcripts/old/subagents/workflows/agent-grandchild.jsonl" })).records).toEqual([]);
    expect(db.prepare("SELECT * FROM messages").all()).toEqual([]);
  });
  it("detects a copied successful claim by its tool name and paired id, without admitting the fork", async () => {
    const records = [
      { message: { role: "assistant", content: [{ type: "tool_use", id: "claim-1", name: "mcp__lcm__lcm_summarize_claim", input: {} }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claim-1", content: JSON.stringify({ job: { prompt: canary, system: "system" } }) }] } },
    ];
    const copied = records.map(record => parseClaudeTranscriptRecord(JSON.stringify(record)).message!);
    expect((await capture.write({ sessionId: "fork", messages: copied })).records).toEqual([]);
    expect(workers.excluded("fork")).toBe(true);
    expect(workers.live("fork", "/project", "claude")).toBe(false);
    expect(db.prepare("SELECT * FROM messages_fts").all()).toEqual([]);
  });

  it("detects a copied Codex CLI claim through the native call id and paired output", async () => {
    const records = [
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "claim", arguments: JSON.stringify({ cmd: "lcm summarize-claim" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "claim", output: JSON.stringify({ job: { system: "system", prompt: canary } }) } },
    ];
    const copied = records.map(record => parseCodexTranscriptRecord(JSON.stringify(record)).message!);
    expect((await capture.write({ sessionId: "codex-fork", messages: copied })).records).toEqual([]);
    expect(workers.live("codex-fork", "/project", "codex")).toBe(false);
  });

  it.each(["claude", "codex"])("a refused %s claim leaves ordinary capture and enrollment unchanged", async client => {
    const history: Parameters<SessionCapture["write"]>[0]["messages"] = [...messages];
    await capture.write({ sessionId: "ordinary", messages: history });
    for (const result of [{ error: "undeclared worker" }, { job: null },
      { isError: true, content: [{ type: "text", text: JSON.stringify({ job: { system: "system", prompt: canary } }) }] },
      { error: "claim refused", job: { system: "system", prompt: canary } }]) {
      const id = `refused-${JSON.stringify(result)}`;
      const records = client === "claude" ? [
        { message: { role: "assistant", content: [{ type: "tool_use", id, name: "lcm_summarize_claim", input: {} }] } },
        { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result) }] } },
      ].map(record => parseClaudeTranscriptRecord(JSON.stringify(record)).message!) : [
        { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd: "lcm summarize-claim" }) } },
        { type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify(result) } },
      ].map(record => parseCodexTranscriptRecord(JSON.stringify(record)).message!);
      history.push(...records);
      expect((await capture.write({ sessionId: "ordinary", messages: history })).records.length).toBeGreaterThan(0);
      expect(workers.excluded("ordinary")).toBe(false);
      expect(workers.list()).toEqual([]);
    }
    expect((await capture.write({ sessionId: "ordinary", messages: [...history, { role: "user", content: "later ordinary capture", tokenCount: 1 }] })).records)
      .toHaveLength(1);
  });

  it("a bare claim invocation does not exclude an ordinary session", async () => {
    const invocation = parseClaudeTranscriptRecord(JSON.stringify({ message: { role: "assistant", content: [
      { type: "tool_use", id: "bare", name: "Bash", input: { command: "lcm summarize-claim" } },
    ] } })).message!;
    expect((await capture.write({ sessionId: "ordinary", messages: [invocation] })).records).toHaveLength(1);
    expect(workers.list()).toEqual([]);
  });

  it.each(["lcm summarize-claim", "/opt/bin/lcm summarize-claim", '"/opt/bin/lcm" summarize-claim', "node /opt/package/lcm.js summarize-claim", "node --no-warnings /opt/package/lcm.js summarize-claim"])("detects a copied claim through its invocation: %s", async command => {
    const records = [
      { message: { role: "assistant", content: [{ type: "tool_use", id: "copied", name: "Bash", input: { command } }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "copied", content: JSON.stringify({ job: { prompt: canary, system: "system" } }) }] } },
    ];
    expect((await capture.write({ sessionId: "fork", messages: records.map(record => parseClaudeTranscriptRecord(JSON.stringify(record)).message!) })).records).toEqual([]);
    expect(workers.excluded("fork")).toBe(true);
    expect(db.prepare("SELECT * FROM message_parts").all()).toEqual([]);
  });

  it("refuses new summaries after exclusion, including an answer already in flight", async () => {
    const old = await capture.write({ sessionId: "worker", messages });
    await capture.write({ sessionId: "worker", messages: [
      parseClaudeTranscriptRecord(JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: "late", name: "lcm_summarize_claim", input: {} }] } })).message!,
      parseClaudeTranscriptRecord(JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "late", content: JSON.stringify({ job: { prompt: canary, system: "system" } }) }] } })).message!,
    ] });
    await expect(capture.summaryStore.insertSummary({ summaryId: "sum_late", conversationId: old.conversationId,
      kind: "leaf", depth: 0, content: canary, tokenCount: 10 })).rejects.toThrow("excluded");
    expect(db.prepare("SELECT * FROM summaries_fts").all()).toEqual([]);
  });

  it("excludes a child by its worker directory even without an attribution sidecar", async () => {
    workers.register({ sessionId: "parent", cwd: "/project", client: "claude", owner: "hook" });
    expect((await capture.write({ sessionId: "agent-child", messages,
      transcriptPath: "/transcripts/parent/subagents/workflows/agent-child.jsonl" })).records).toEqual([]);
  });
});

describe("worker gate on transcript reads", () => {
  let dir: string;
  let db: DatabaseSync;
  let capture: SessionCapture;
  let workers: WorkerStore;
  const claimPair = (command: string) => [
    { message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_claim", name: "Bash", input: { command } }] } },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_claim",
      content: JSON.stringify({ job: { id: "job-issued", prompt: canary, system: "system" } }) }] } },
  ];
  const writeTranscript = (name: string, records: unknown[]) => {
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return path;
  };
  const count = (table: string, sessionId: string) => (db.prepare(
    `SELECT count(*) AS n FROM ${table} JOIN conversations USING(conversation_id) WHERE session_id = ?`,
  ).get(sessionId) as { n: number }).n;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lcm-worker-gate-"));
    db = new DatabaseSync(join(dir, "db.sqlite"));
    runLcmMigrations(db, { claudeProjectsDir: "/nonexistent" });
    capture = new SessionCapture(db, "project", new ScrubEngine([], []));
    workers = new WorkerStore(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("keeps a repairable session's history when its rebuild meets a copied claim", async () => {
    const turns = [["user", "q1"], ["assistant", "r1"], ["user", "q2"], ["assistant", "r2"]] as const;
    // Stored history that is not the transcript's prefix, so the session is repairable.
    await capture.write({ sessionId: "ordinary", parserShape: CLAUDE_PARSER_SHAPE, messages: [
      { role: "user", content: "q1", tokenCount: 1 }, { role: "assistant", content: "r2", tokenCount: 1 },
      { role: "user", content: "q2", tokenCount: 1 }, { role: "user", content: "q2", tokenCount: 1 },
    ] });
    const path = writeTranscript("ordinary", [
      ...turns.map(([role, content]) => ({ message: { role, content } })), ...claimPair("lcm summarize-claim"),
    ]);
    const before = count("messages", "ordinary");

    const rebuilt = await capture.rebuildTranscript({ sessionId: "ordinary", cwd: dir, transcriptPath: path });

    expect(rebuilt).toMatchObject({ plan: { kind: "unavailable" }, ingested: 0 });
    expect(count("messages", "ordinary")).toBe(before);
    expect(workers.get("ordinary")?.exclusion_reason).toBe("copied-claim");
  });

  it("refuses without excluding a session whose request names another session's transcript", async () => {
    const path = writeTranscript("worker-session", [{ message: { role: "user", content: "work" } }, ...claimPair("lcm summarize-claim")]);

    const result = await capture.captureTranscript({ sessionId: "victim", cwd: dir, transcriptPath: path });

    expect(result?.records ?? []).toEqual([]);
    expect(count("messages", "victim")).toBe(0);
    expect(workers.excluded("victim")).toBe(false);
  });
});
