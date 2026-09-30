import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCodexTranscriptRecord } from "../src/codex-transcript.js";
import { parseClaudeTranscriptRecord } from "../src/transcript.js";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { WorkerStore } from "../src/store/worker-store.js";
import { SessionCapture } from "../src/capture.js";
import { ScrubEngine } from "../src/scrub.js";
import { PromotedStore } from "../src/db/promoted.js";

const canary = "FOREIGN_WORKER_CONTENT_685";
const messages = [{ role: "user" as const, content: canary, tokenCount: 10 }];
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

  it("cleans captured content and provenanced promotions, preserves the tombstone and unrelated session", async () => {
    const old = await capture.write({ sessionId: "worker", messages });
    await capture.write({ sessionId: "ordinary", messages: [{ ...messages[0], content: "ordinary" }] });
    await capture.summaryStore.insertSummary({ summaryId: "sum_worker", conversationId: old.conversationId,
      kind: "leaf", depth: 0, content: canary, tokenCount: 10 });
    new PromotedStore(db).insert({ content: canary, projectId: "project", sessionId: "worker" });
    new PromotedStore(db).insert({ content: "unknown provenance", projectId: "project" });
    const result = workers.register({ sessionId: "worker", cwd: "/project", client: "claude", owner: "hook" });
    expect(result.unprovenanced).toBe(1);
    for (const table of ["messages", "summaries", "messages_fts", "summaries_fts", "promoted", "promoted_fts"]) {
      expect(db.prepare(`SELECT 1 FROM ${table} WHERE content LIKE ?`).get(`%${canary}%`), table).toBeUndefined();
    }
    expect(db.prepare("SELECT * FROM session_ingest_log WHERE session_id = 'worker'").get()).toBeDefined();
    expect((await capture.write({ sessionId: "worker", messages })).records).toEqual([]);
    expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "ordinary" }]);
  });

  it("revokes the previous id on clear but permanently excludes resumed history and descendants", async () => {
    workers.register({ sessionId: "old", cwd: "/project", client: "claude", owner: "hook" });
    workers.register({ sessionId: "new", cwd: "/project", client: "claude", owner: "hook" });
    expect(workers.live("old", "/project", "claude")).toBe(false);
    expect(workers.live("new", "/project", "claude")).toBe(true);
    expect((await capture.write({ sessionId: "old", messages })).records).toEqual([]);
    expect((await capture.write({ sessionId: "child", messages, attribution: { parentSessionId: "old" } })).records).toEqual([]);
    expect((await capture.write({ sessionId: "grandchild", messages, attribution: { parentSessionId: "child" } })).records).toEqual([]);
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

  it("refuses new summaries after exclusion, including an answer already in flight", async () => {
    const old = await capture.write({ sessionId: "worker", messages });
    workers.register({ sessionId: "worker", cwd: "/project", client: "claude", owner: "hook" });
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
