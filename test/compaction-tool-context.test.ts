import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CompactionEngine, type CompactionSummarizeFn } from "../src/compaction.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { buildSummaryPrompt } from "../src/llm/prompt.js";
import { SummaryRejectedError } from "../src/llm/summary-rejection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

let db: DatabaseSync, conversations: ConversationStore, summaries: SummaryStore;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  conversations = new ConversationStore(db);
  summaries = new SummaryStore(db);
});
afterEach(() => db.close());

async function window(session = "window") {
  return (await conversations.getOrCreateConversation(session)).conversationId;
}

async function call(conversationId: number, command: string, outcome: string, reason?: string) {
  const conversation = await conversations.getConversation(conversationId);
  const message = await conversations.createMessage({
    conversationId, seq: (await conversations.getMaxSeq(conversationId)) + 1,
    role: "assistant", content: "Working through the build configuration. ".repeat(80), tokenCount: 800,
    eventAt: new Date("2026-01-01T00:00:00Z"),
  });
  await summaries.appendContextMessages(conversationId, [message.messageId]);
  db.prepare(`INSERT INTO transcript_tool_calls
    (session_id, call_id, message_id, name, input, outcome, block_reason)
    VALUES (?, ?, ?, 'Bash', ?, ?, ?)`).run(
    conversation!.sessionId, String(message.messageId), message.messageId, command, outcome, reason ?? null,
  );
  return message.messageId;
}

async function compact(conversationId: number) {
  const prompts: string[] = [];
  const contexts: Parameters<CompactionSummarizeFn>[2][] = [];
  const summarize: CompactionSummarizeFn = async (text, aggressive, options) => {
    contexts.push(options);
    prompts.push(buildSummaryPrompt(text, aggressive, options ?? {}));
    return "npm install old failed; npm install new worked. Hook blocks deployments.\nFiles: none\nExpand for details about: build";
  };
  const engine = new CompactionEngine(conversations, summaries, {
    contextThreshold: 0.75, freshTailCount: 0, leafChunkTokens: 20_000,
    leafMinFanout: 10, condensedMinFanout: 10, condensedTargetTokens: 900,
  });
  await engine.compact({ conversationId, tokenBudget: 200_000, summarize, force: true });
  return { prompts, contexts };
}

it("supplies the window's pairs and block reasons in the existing leaf call and stores its brief result", async () => {
  const cid = await window();
  await call(cid, "npm install old", "failed");
  await call(cid, "npm install new", "succeeded");
  await call(cid, "make deploy", "blocked", "PreToolUse:Bash hook error: deployments are disabled");
  const unrelated = await window("other-session");
  await call(unrelated, "npm install unrelated-old", "failed");
  await call(unrelated, "npm install unrelated-new", "succeeded");

  const { prompts, contexts } = await compact(cid);
  expect(prompts).toHaveLength(1);
  expect(contexts[0]).toMatchObject({ toolContext: {
    errorFixPairs: [{ failedCommand: "npm install old", succeededCommand: "npm install new" }],
    blocked: [{ command: "make deploy", reason: "PreToolUse:Bash hook error: deployments are disabled" }],
  } });
  expect(contexts[0]!.toolContext!.errorFixPairs).toEqual([{ failedCommand: "npm install old", succeededCommand: "npm install new" }]);
  expect(prompts[0]).toContain("Each failure, fix and block belongs only to the command it names.");
  expect(prompts[0]).toContain('<tool_context>');
  expect(prompts[0]).toContain('"failedCommand":"npm install old"');
  expect(prompts[0]).toContain("the failed command and the command that worked after it");
  expect(prompts[0]).toContain("the command and why it was blocked");
  expect(prompts[0]).not.toContain("unrelated");
  const items = await summaries.getContextItems(cid);
  expect((await summaries.getSummary(items[0].summaryId!))?.content).toContain("npm install old failed; npm install new worked.");
});

it.each([false, true])("keeps the pre-change prompt byte for byte without failed or blocked calls (aggressive=%s)", async aggressive => {
  const cid = await window();
  for (const outcome of ["succeeded", "unknown", "denied", "interrupted"]) {
    await call(cid, "npm install ordinary", outcome);
  }
  const before = JSON.parse(readFileSync(new URL("./fixtures/leaf-prompts-before-tool-context.json", import.meta.url), "utf8"));
  const engine = new CompactionEngine(conversations, summaries, {
    contextThreshold: 0.75, freshTailCount: 0, leafMinFanout: 10, condensedMinFanout: 10, condensedTargetTokens: 900,
  });
  const prompts: string[] = [];
  await engine.compact({ conversationId: cid, tokenBudget: 200_000, force: true,
    summarize: async (text, _aggressive, options) => {
      expect(options).not.toHaveProperty("toolContext");
      const prompt = buildSummaryPrompt(text, aggressive, { ...options, targetTokens: 500 });
      prompts.push(prompt);
      const vars: Record<string, string> = {
        text, targetTokens: "500", previousContext: "(none)",
        instructionBlock: "Operator instructions: (none)", language: "",
      };
      const expected = before[aggressive ? "aggressive" : "normal"]
        .replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => vars[key]);
      expect(prompt).toBe(expected);
      return "Files: none\nBuild checked.\nExpand for details about: build";
    },
  });
  expect(prompts).toHaveLength(1);
});

it("re-derives evidence for each half after an output cut", async () => {
  const cid = await window();
  await call(cid, "npm install old", "failed");
  await call(cid, "npm install new", "succeeded");
  await call(cid, "cargo build old", "failed");
  await call(cid, "cargo build new", "succeeded");
  const prompts: string[] = [];
  const engine = new CompactionEngine(conversations, summaries, {
    contextThreshold: 0.75, freshTailCount: 0, leafMinFanout: 10, condensedMinFanout: 10, condensedTargetTokens: 900,
  });
  await engine.compact({ conversationId: cid, tokenBudget: 200_000, force: true,
    summarize: async (text, aggressive, options) => {
      prompts.push(buildSummaryPrompt(text, aggressive, options ?? {}));
      if (prompts.length === 1) throw new SummaryRejectedError({ reason: "length", provider: "fake" });
      return "Files: none\nBuild checked.\nExpand for details about: build";
    },
  });
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).toContain('"failedCommand":"npm install old"');
  expect(prompts[1]).not.toContain("cargo build");
  expect(prompts[2]).toContain('"failedCommand":"cargo build old"');
  expect(prompts[2]).not.toContain("npm install");
});

it("bounds structured input to 8192 UTF-8 bytes and commands to the stored 2048-byte limit", async () => {
  const cid = await window();
  for (let index = 0; index < 12; index++) {
    await call(cid, `npm install old-${index}-${"界".repeat(1500)}`, "failed");
    await call(cid, `npm install new-${index}-${"界".repeat(1500)}`, "succeeded");
  }
  await call(cid, "make deploy", "blocked", "PreToolUse:Bash hook error: deployments are disabled");
  const { prompts, contexts } = await compact(cid);
  const context = contexts[0]!.toolContext!;
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(8192);
  expect(context.errorFixPairs.length).toBeGreaterThan(0);
  expect(context.omitted).toBeGreaterThan(0);
  for (const pair of context.errorFixPairs) {
    for (const command of [pair.failedCommand, pair.succeededCommand]) {
      expect(Buffer.byteLength(command)).toBeLessThanOrEqual(2048);
      expect(command).toMatch(/\n\[truncated\]$/);
      expect(command).not.toContain("�");
    }
  }
  const structured = prompts[0].split("<tool_context>\n")[1].split("\n</tool_context>")[0];
  expect(Buffer.byteLength(structured)).toBeLessThanOrEqual(8192);
  expect(JSON.parse(structured)).toEqual(context);
});

it("scrubs and caps blocked commands and reasons as complete budgeted entries", async () => {
  const cid = await window();
  for (let index = 0; index < 4; index++) {
    await call(cid, `make deploy-${index}-SECRET-${"界".repeat(1500)}`, "blocked", `blocked SECRET ${"界".repeat(1500)}`);
  }
  const engine = new CompactionEngine(conversations, summaries, {
    contextThreshold: 0.75, freshTailCount: 0, leafMinFanout: 10, condensedMinFanout: 10,
    scrubber: { scrub: (text: string) => text.replaceAll("SECRET", "MASKED") },
  });
  const contexts: Parameters<CompactionSummarizeFn>[2][] = [];
  await engine.compact({ conversationId: cid, tokenBudget: 200_000, force: true,
    summarize: async (_text, _aggressive, options) => {
      contexts.push(options);
      return "Files: none\nBuild checked.\nExpand for details about: build";
    },
  });
  expect(contexts).toHaveLength(1);
  const context = contexts[0]!.toolContext!;
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(8192);
  expect(context.blocked.length).toBeGreaterThan(0);
  expect(context.omitted).toBe(4 - context.blocked.length);
  for (const block of context.blocked) {
    for (const text of [block.command, block.reason]) {
      expect(text).toContain("MASKED");
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("�");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
      expect(text).toMatch(/\n\[truncated\]$/);
    }
  }
});
