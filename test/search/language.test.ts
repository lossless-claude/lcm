import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { detectLanguage, isDistinctivePrompt, sampleHumanTurns } from "../../src/search/language.js";

async function seed(db: DatabaseSync, sessions: Array<{ sessionId: string; turns: string[] }>): Promise<void> {
  const store = new ConversationStore(db);
  for (const { sessionId, turns } of sessions) {
    const conv = await store.getOrCreateConversation(sessionId);
    await store.createMessagesBulk(turns.map((content, i) => ({
      conversationId: conv.conversationId,
      seq: i,
      role: "user" as const,
      content,
      tokenCount: Math.ceil(content.length / 4),
    })));
  }
}

const HUMAN = "Bora revisar o daemon de memória antes do release desta semana, por favor?";
const LISTING = "src/daemon/routes/compact.ts:12: export async function compactRoute(req: GitHub, res: Stripe) {";

describe("sampleHumanTurns", () => {
  it("takes one distinctive human turn per conversation, oldest first, skipping tool output and subagents", async () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db);
    await seed(db, [
      { sessionId: "s1", turns: [LISTING, HUMAN + " (1)", HUMAN + " (1b)"] },
      { sessionId: "agent-x", turns: [HUMAN + " (agent)"] },
      { sessionId: "s2", turns: ["ok", HUMAN + " (2)"] },
    ]);
    expect(sampleHumanTurns(db)).toEqual([HUMAN + " (1)", HUMAN + " (2)"]);
    expect(sampleHumanTurns(db, 1)).toEqual([HUMAN + " (1)"]);
  });
});

describe("isDistinctivePrompt", () => {
  it("rejects listings, harness blocks and short turns", () => {
    expect(isDistinctivePrompt(HUMAN)).toBe(true);
    expect(isDistinctivePrompt(LISTING)).toBe(false);
    expect(isDistinctivePrompt("<system-reminder>ignore</system-reminder> " + HUMAN)).toBe(false);
    expect(isDistinctivePrompt("ok")).toBe(false);
  });
});

describe("detectLanguage", () => {
  it("numbers the sample, asks for a tag and canonicalises the reply", async () => {
    const summarize = vi.fn().mockResolvedValue(" pt_br\n");
    expect(await detectLanguage(["Bora revisar?", "Quebrou de novo."], summarize)).toBe("pt-BR");
    expect(summarize.mock.calls[0][0]).toContain("1. Bora revisar?");
    expect(summarize.mock.calls[0][0]).toContain("2. Quebrou de novo.");
    expect(summarize.mock.calls[0][2].taskPrompt).toContain("BCP 47");
  });

  it("is unsure on prose and never calls the model for an empty sample", async () => {
    const summarize = vi.fn().mockResolvedValue("The person writes in Portuguese.");
    expect(await detectLanguage(["Bora revisar?"], summarize)).toBeNull();
    expect(await detectLanguage([], summarize)).toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
