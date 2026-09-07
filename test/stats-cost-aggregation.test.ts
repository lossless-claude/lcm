import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, afterEach, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { recordCompactLlmUsage, type CompactLlmUsage } from "../src/daemon/routes/compact.js";
import { collectStats } from "../src/stats.js";
import { ConversationStore } from "../src/store/conversation-store.js";

// collectStats() scans every project database under homedir()/.lossless-claude.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

function usage(overrides: Partial<CompactLlmUsage> = {}): CompactLlmUsage {
  return {
    provider: "openai",
    model: "z-ai/glm-5.3-flash",
    calls: 1,
    okCalls: 1,
    failedCalls: 0,
    tokensSpent: 1000,
    tokensInput: 900,
    tokensCached: 0,
    tokensOutput: 100,
    callsWithCost: 0,
    ...overrides,
  };
}

describe("collectStats cost aggregation", () => {
  let home: string | undefined;

  afterEach(() => {
    vi.mocked(homedir).mockReset();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  // collectStats() skips a project with no stored messages, so each fixture
  // needs one before its usage row is counted at all.
  async function withProjects(...usages: CompactLlmUsage[][]): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "lcm-cost-home-"));
    vi.mocked(homedir).mockReturnValue(home);
    for (const [i, rows] of usages.entries()) {
      const dir = join(home!, ".lossless-claude", "projects", `p${i}`);
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(join(dir, "db.sqlite"));
      runLcmMigrations(db);
      const conversations = new ConversationStore(db);
      const conversation = await conversations.getOrCreateConversation(`session-${i}`);
      await conversations.createMessagesBulk([
        { conversationId: conversation.conversationId, seq: 0, role: "user", content: "Hello", tokenCount: 5 },
      ]);
      for (const row of rows) recordCompactLlmUsage(db, row);
      db.close();
    }
  }

  it("reports a priced project's cost even when another project priced nothing", async () => {
    await withProjects(
      [usage({ costUsd: 0.0004, callsWithCost: 1 })],
      [usage({ provider: "anthropic", model: "claude-haiku-4-5-20251001" })],
    );
    const stats = collectStats();
    // The unpriced project must not drag the known total down to 0.
    expect(stats.llmUsage.costUsd).toBeCloseTo(0.0004, 9);
    expect(stats.llmUsage.callsWithCost).toBe(1);
    expect(stats.llmUsage.calls).toBe(2);
  });

  it("keeps the total null when no project priced anything", async () => {
    await withProjects([usage()], [usage({ model: "other" })]);
    const stats = collectStats();
    // null, not 0: those calls were charged, nothing reported how much.
    expect(stats.llmUsage.costUsd).toBeNull();
    expect(stats.llmUsage.callsWithCost).toBe(0);
    expect(stats.llmUsage.calls).toBe(2);
  });

  it("sums costs across projects that both priced", async () => {
    await withProjects(
      [usage({ costUsd: 0.0004, callsWithCost: 1 })],
      [usage({ costUsd: 0.0006, callsWithCost: 1 })],
    );
    const stats = collectStats();
    expect(stats.llmUsage.costUsd).toBeCloseTo(0.001, 9);
    expect(stats.llmUsage.callsWithCost).toBe(2);
  });
});
