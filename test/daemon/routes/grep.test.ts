import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";
import { RetrievalEngine } from "../../../src/retrieval.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { lcmHome } from "../../../src/lcm-home.js";

const paths = createLcmPaths(lcmHome());
let cwd: string;
let db: DatabaseSync;
let daemon: DaemonInstance | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  db?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

async function fixture(fts5Available = true) {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "grep-summary-")));
  const dbPath = projectDbPath(cwd, paths);
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  const conversations = new ConversationStore(db, { fts5Available });
  const summaries = new SummaryStore(db, { fts5Available });
  const conversation = await conversations.getOrCreateConversation("selected-session");
  const other = await conversations.getOrCreateConversation("other-session");
  const ids: number[] = [];
  for (let seq = 0; seq < 5; seq++) {
    const message = await conversations.createMessage({
      conversationId: seq === 4 ? other.conversationId : conversation.conversationId,
      seq, role: "user", content: "needle exact history", tokenCount: 5,
    });
    ids.push(message.messageId);
  }
  for (const [summaryId, depth] of [["sum_leaf_a", 0], ["sum_leaf_b", 0], ["sum_middle", 1], ["sum_root", 2], ["sum_outside", 0]] as const) {
    await summaries.insertSummary({ summaryId, depth, conversationId: conversation.conversationId,
      kind: depth ? "condensed" : "leaf", content: "needle summarized history", tokenCount: 5 });
  }
  await summaries.linkSummaryToMessages("sum_leaf_a", [ids[0]]);
  await summaries.linkSummaryToMessages("sum_leaf_b", [ids[1]]);
  await summaries.linkSummaryToMessages("sum_outside", [ids[2]]);
  // Compaction links the newly condensed summary to the summaries it replaced.
  await summaries.linkSummaryToParents("sum_middle", ["sum_leaf_a", "sum_leaf_b"]);
  await summaries.linkSummaryToParents("sum_root", ["sum_middle"]);
  return { engine: new RetrievalEngine(conversations, summaries), ids, conversationId: conversation.conversationId };
}

describe("summary-scoped grep", () => {
  it.each([["full_text", true], ["full_text", false], ["regex", true]] as const)(
    "filters %s matches before limits (FTS enabled: %s) and names covering summaries", async (mode, fts) => {
      const { engine, ids } = await fixture(fts);
      const result = await engine.grep({ query: "needle", mode, scope: "both", summaryId: "sum_root", limit: 1 });
      expect(result.messages).toHaveLength(1);
      expect([ids[0], ids[1]]).toContain(result.messages[0].messageId);
      expect(result.messages[0]).toHaveProperty("summaryIds", result.messages[0].messageId === ids[0]
        ? ["sum_leaf_a", "sum_middle", "sum_root"] : ["sum_leaf_b", "sum_middle", "sum_root"]);
      expect(result.summaries).toHaveLength(1);
      expect(["sum_leaf_a", "sum_leaf_b", "sum_middle", "sum_root"]).toContain(result.summaries[0].summaryId);
      const leaf = await engine.grep({ query: "needle", mode, scope: "messages", summaryId: "sum_leaf_a" });
      expect(leaf.messages.map(m => m.messageId)).toEqual([ids[0]]);
      expect(leaf.summaries).toEqual([]);
      expect(await engine.grep({ query: "needle", mode, scope: "both", summaryId: "sum_missing" }))
        .toEqual({ messages: [], summaries: [], totalMatches: 0 });
    },
  );

  it("names covering summaries without a scope and marks unsummarized messages", async () => {
    const { engine, ids } = await fixture();
    const result = await engine.grep({ query: "needle", mode: "full_text", scope: "messages" });
    expect(result.messages.find(m => m.messageId === ids[0])).toHaveProperty("summaryIds", ["sum_leaf_a", "sum_middle", "sum_root"]);
    expect(result.messages.find(m => m.messageId === ids[3])).toHaveProperty("summaryIds", []);
  });

  it("accepts summary_id on the daemon route and intersects session and time filters", async () => {
    const { ids } = await fixture();
    const config = loadDaemonConfig(cwd, { daemon: { port: 0 } });
    daemon = await createDaemon(config);
    const post = async (input: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${daemon!.address().port}/grep`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, query: "needle", ...input }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ messages: Array<{ messageId: number; summaryIds: string[] }>; summaries: unknown[]; totalMatches: number }>;
    };
    const scoped = await post({ summary_id: "sum_root", scope: "messages", sessionId: "selected-session" });
    expect(scoped.messages.map(m => m.messageId).sort()).toEqual([ids[0], ids[1]]);
    expect(scoped.messages.every(m => m.summaryIds.includes("sum_root"))).toBe(true);
    expect((await post({ summary_id: "sum_root", sessionId: "other-session" })).totalMatches).toBe(0);
    expect((await post({ summary_id: "sum_root", sessionId: "missing-session" })).totalMatches).toBe(0);
    expect((await post({ summary_id: "sum_root", since: "2999-01-01T00:00:00Z" })).totalMatches).toBe(0);
  });
});
