import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectDir } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";

describe("POST /expand source messages", () => {
  let cwd: string;
  let daemon: DaemonInstance | undefined;
  let sourceMessages: Array<{ messageId: number; role: string; snippet: string; tokenCount: number }>;

  beforeEach(async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-expand-leaf-")));
    mkdirSync(projectDir(cwd), { recursive: true });
    const db = new DatabaseSync(projectDbPath(cwd));
    try {
      runLcmMigrations(db);
      const conversations = new ConversationStore(db);
      const summaries = new SummaryStore(db);
      const { conversationId } = await conversations.getOrCreateConversation("expand-fixture");
      const messages = await conversations.createMessagesBulk([
        { conversationId, seq: 0, role: "user", content: "Use cobalt brackets for the solar panels.", tokenCount: 9 },
        { conversationId, seq: 1, role: "assistant", content: "Cobalt brackets confirmed.", tokenCount: 4 },
      ]);
      sourceMessages = messages.map(({ messageId, role, content, tokenCount }) => ({ messageId, role, snippet: content, tokenCount }));
      await summaries.insertSummary({ summaryId: "sum_leaf", conversationId, kind: "leaf", content: "Bracket decision.", tokenCount: 3 });
      await summaries.linkSummaryToMessages("sum_leaf", messages.map(message => message.messageId));
      await summaries.insertSummary({ summaryId: "sum_parent", conversationId, kind: "condensed", content: "Project decisions.", tokenCount: 3 });
      await summaries.linkSummaryToParents("sum_leaf", ["sum_parent"]);
    } finally {
      db.close();
    }
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (cwd) {
      rmSync(projectDir(cwd), { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  async function expand(nodeId: string, depth?: number) {
    const response = await fetch(`http://127.0.0.1:${daemon!.address().port}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, nodeId, depth }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.error).toBeUndefined();
    return result;
  }

  it("returns the linked source messages for a leaf at the default depth", async () => {
    const result = await expand("sum_leaf");
    expect(result.expansions).toEqual([{ summaryId: "sum_leaf", children: [], messages: sourceMessages }]);
    expect(result.totalTokens).toBe(13);
    expect(result.truncated).toBe(false);
  });

  it("includes leaf messages under a condensed summary only when depth reaches the leaf", async () => {
    const shallow = await expand("sum_parent", 1);
    expect(shallow.expansions[0].children).toEqual([
      { summaryId: "sum_leaf", kind: "leaf", snippet: "Bracket decision.", tokenCount: 3 },
    ]);
    expect(shallow.expansions[0].messages).toEqual([]);
    const deep = await expand("sum_parent", 2);
    expect(deep.expansions[0].messages).toEqual(sourceMessages);
    expect(deep.totalTokens).toBe(16);
  });
});
