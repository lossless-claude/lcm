import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { ScrubEngine } from "../src/scrub.js";
import { SessionCapture, attributionFromTranscriptPath, isSessionComplete, markSessionComplete } from "../src/capture.js";
import type { ParsedMessage } from "../src/transcript.js";

const msg = (role: ParsedMessage["role"], content: string, parts?: ParsedMessage["parts"]): ParsedMessage =>
  ({ role, content, tokenCount: 1, ...(parts ? { parts } : {}) });

const conversation = [
  msg("user", "hi"),
  msg("assistant", "hello"),
  msg("user", "<command-name>/model</command-name>", [{ type: "command", name: "/model", args: "opus" }]),
  msg("assistant", "done"),
];

describe("SessionCapture", () => {
  let db: DatabaseSync;
  let capture: SessionCapture;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db);
    capture = new SessionCapture(db, "proj", new ScrubEngine([], []));
  });
  afterEach(() => db.close());

  const stored = () => ({
    messages: db.prepare("SELECT seq, role, content FROM messages ORDER BY seq").all(),
    contextItems: db.prepare("SELECT COUNT(*) AS n FROM context_items").get() as { n: number },
    parts: db.prepare(
      `SELECT m.seq, part_type, tool_name, tool_input FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id ORDER BY m.seq, ordinal`,
    ).all(),
  });

  it("writes only the delta past the stored count, twice in a row", async () => {
    const first = await capture.write({ sessionId: "s1", messages: conversation.slice(0, 2) });
    expect(first.records).toHaveLength(2);

    const second = await capture.write({ sessionId: "s1", messages: conversation });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.records.map((r) => r.seq)).toEqual([2, 3]);

    const { messages, contextItems, parts } = stored();
    expect(messages).toEqual([
      { seq: 0, role: "user", content: "hi" },
      { seq: 1, role: "assistant", content: "hello" },
      { seq: 2, role: "user", content: "<command-name>/model</command-name>" },
      { seq: 3, role: "assistant", content: "done" },
    ]);
    expect(contextItems.n).toBe(4);
    expect(parts).toEqual([{ seq: 2, part_type: "command", tool_name: "/model", tool_input: "opus" }]);
  });

  it("replaying the full transcript writes nothing new", async () => {
    await capture.write({ sessionId: "s1", messages: conversation });
    const replay = await capture.write({ sessionId: "s1", messages: conversation });
    expect(replay.records).toHaveLength(0);
    expect(stored().messages).toHaveLength(4);
    expect(stored().parts).toHaveLength(1);
  });

  it("a suffix read from a source offset resumes exactly at the stored count", async () => {
    await capture.write({ sessionId: "s1", messages: conversation.slice(0, 3) });
    // The source skipped 2 messages; the store holds 3, so only the last one is new.
    const result = await capture.write({ sessionId: "s1", messages: conversation.slice(2), sourceOffset: 2 });
    expect(result.records.map((r) => r.seq)).toEqual([3]);
    expect(stored().messages).toHaveLength(4);
  });

  it("creates the conversation with attribution even when there is nothing to write", async () => {
    const result = await capture.write({
      sessionId: "agent-1", messages: [], attribution: { parentSessionId: "parent", subagentType: "Explore", subagentDesc: "look" },
    });
    expect(result.records).toHaveLength(0);
    const row = db.prepare("SELECT parent_session_id, subagent_type, subagent_desc FROM conversations WHERE session_id = ?")
      .get("agent-1");
    expect(row).toEqual({ parent_session_id: "parent", subagent_type: "Explore", subagent_desc: "look" });
    expect(await capture.stored("agent-1")).toEqual({ conversationId: result.conversationId, storedCount: 0 });
  });

  it("reads attribution from the sidecar of a subagent transcript when the caller has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-capture-"));
    try {
      const subagents = join(dir, "parent-session", "subagents");
      mkdirSync(subagents, { recursive: true });
      const path = join(subagents, "agent-2.jsonl");
      writeFileSync(path, "");
      writeFileSync(join(subagents, "agent-2.meta.json"), JSON.stringify({ agentType: "Plan", description: "plan it" }));

      expect(attributionFromTranscriptPath(path)).toEqual({ parentSessionId: "parent-session", subagentType: "Plan", subagentDesc: "plan it" });
      expect(attributionFromTranscriptPath(join(dir, "parent-session.jsonl"))).toBeUndefined();

      await capture.write({ sessionId: "agent-2", transcriptPath: path, messages: conversation.slice(0, 1) });
      const row = db.prepare("SELECT parent_session_id, subagent_type FROM conversations WHERE session_id = ?").get("agent-2");
      expect(row).toEqual({ parent_session_id: "parent-session", subagent_type: "Plan" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scrubs content and tallies redaction counts per project", async () => {
    const result = await capture.write({
      sessionId: "s1", messages: [msg("user", "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here")],
    });
    expect(result.records[0].content).not.toContain("ghp_AAAA");
    expect(result.totalCounts.gitleaks).toBeGreaterThan(0);
    const row = db.prepare("SELECT count FROM redaction_stats WHERE category = 'gitleaks'").get() as { count: number };
    expect(row.count).toBe(result.totalCounts.gitleaks);
  });

  it("owns the session ingest log", () => {
    expect(isSessionComplete(db, "s1")).toBe(false);
    markSessionComplete(db, "s1", 4);
    expect(isSessionComplete(db, "s1")).toBe(true);
    markSessionComplete(db, "s1", 6);
    expect(db.prepare("SELECT message_count FROM session_ingest_log WHERE session_id = 's1'").get()).toEqual({ message_count: 6 });
  });
});
