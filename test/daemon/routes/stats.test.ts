import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";

// collectStats() scans every project database under the lcm home, opening each one
// writable and running migrations. Point LCM_HOME at a
// temporary tree so the test never touches (or waits on) the user's real data.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe("GET /stats", () => {
  let daemon: DaemonInstance;
  let port: number;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "lcm-stats-home-"));
    process.env.LCM_HOME = join(home, ".lossless-claude");

    // One project with two messages and one summary, so the aggregation path
    // runs instead of the empty-tree early return.
    const projectDir = join(home, ".lossless-claude", "projects", "stats-fixture");
    mkdirSync(projectDir, { recursive: true });
    const db = new DatabaseSync(join(projectDir, "db.sqlite"));
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const conversation = await conversations.getOrCreateConversation("stats-session");
    await conversations.createMessagesBulk([
      { conversationId: conversation.conversationId, seq: 0, role: "user", content: "Hello", tokenCount: 5 },
      { conversationId: conversation.conversationId, seq: 1, role: "assistant", content: "Hi there", tokenCount: 3 },
    ]);
    await new SummaryStore(db).insertSummary({
      summaryId: "sum_stats_1",
      conversationId: conversation.conversationId,
      kind: "condensed",
      content: "User greeted assistant",
      tokenCount: 10,
      sourceMessageTokenCount: 8,
    });
    db.close();

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    port = daemon.address().port;
  });

  afterAll(async () => {
    await daemon.stop();
    delete process.env.LCM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns 200 with OverallStats shape including redactionCounts and llmUsage", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.projects).toBe(1);
    expect(body.conversations).toBe(1);
    expect(body.messages).toBe(2);
    expect(body.summaries).toBe(1);
    expect(body).toHaveProperty("redactionCounts");
    expect(body).toHaveProperty("llmUsage");
    expect(body.redactionCounts).toMatchObject({
      builtIn: expect.any(Number),
      global: expect.any(Number),
      project: expect.any(Number),
      total: expect.any(Number),
    });
    expect(body.llmUsage).toMatchObject({
      calls: expect.any(Number),
      okCalls: expect.any(Number),
      failedCalls: expect.any(Number),
      tokensSpent: expect.any(Number),
    });
    expect(body.llmUsage).not.toHaveProperty("callsOk");
    expect(body.llmUsage).not.toHaveProperty("callsFailed");
  });

  it("redactionCounts.total equals sum of built-in, global, and project", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      redactionCounts: { builtIn: number; global: number; project: number; total: number };
    };
    const rc = body.redactionCounts;
    expect(rc.total).toBe(rc.builtIn + rc.global + rc.project);
  });
});
