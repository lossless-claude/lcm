import { expect, it } from "vitest";
import { buildSyntheticSession, runEval } from "../src/eval/engine.js";
import { buildSummaryPrompt } from "../src/llm/prompt.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { loadCorpusDir } from "./bench/summarizer-eval-harness.js";

it("loads corpus calls, records the real prompt and scores both sides of a pair", async () => {
  const session = buildSyntheticSession();
  session.messages[0].toolCalls = [{
    callId: "failure", name: "Bash", input: "npm install legacy-widget", outcome: "failed",
  }];
  session.messages[1].toolCalls = [{
    callId: "fix", name: "Bash", input: "npm install current-widget", outcome: "succeeded",
  }];
  const prompts: string[] = [];
  for (const retain of [true, false]) {
    const result = await runEval({ session, model: "fake", provider: "fake", run: 1,
      summarizer: async (text, aggressive, ctx = {}) => {
        prompts.push(buildSummaryPrompt(text, aggressive, ctx));
        return retain
          ? "npm install legacy-widget failed; npm install current-widget worked.\nFiles: none\nExpand for details about: build"
          : "The build worked.\nFiles: none\nExpand for details about: build";
      },
    });
    expect(result.calls[0].toolPairRetention).toEqual([{
      failedCommand: "npm install legacy-widget", succeededCommand: "npm install current-widget", retained: retain,
    }]);
    expect(result.calls[0].prompt).toBe(prompts[0]);
    expect(result.calls[0].prompt).toContain('"failedCommand":"npm install legacy-widget"');
    expect(result.calls[0].unsupportedDetails).toEqual([]);
    prompts.length = 0;
  }
});

it("can run a baseline without structured input, preserving control prompts and summaries", async () => {
  const control = buildSyntheticSession();
  const withPair = structuredClone(control);
  withPair.messages[0].toolCalls = [{ callId: "failure", name: "Bash", input: "npm install old", outcome: "failed" }];
  withPair.messages[1].toolCalls = [{ callId: "fix", name: "Bash", input: "npm install new", outcome: "succeeded" }];
  for (const session of [control, withPair]) {
    const results = [];
    for (const toolContext of [true, false]) {
      const prompts: string[] = [];
      const result = await runEval({ session, model: "fake", provider: "fake", run: 1, toolContext,
        summarizer: async (text, aggressive, ctx = {}) => {
          const prompt = buildSummaryPrompt(text, aggressive, ctx);
          prompts.push(prompt);
          return prompt.includes("<tool_context>")
            ? "npm install old failed; npm install new worked.\nFiles: none\nExpand for details about: build"
            : "Build checked.\nFiles: none\nExpand for details about: build";
        },
      });
      expect(result.toolContextEnabled).toBe(toolContext);
      expect(result.calls.map(call => call.prompt)).toEqual(prompts);
      results.push(result);
    }
    if (session === control) {
      expect(results[0].calls.map(call => call.prompt)).toEqual(results[1].calls.map(call => call.prompt));
      expect(results[0].summaries.map(summary => summary.content)).toEqual(results[1].summaries.map(summary => summary.content));
    } else {
      expect(results[0].calls[0].toolPairRetention?.[0].retained).toBe(true);
      expect(results[1].calls[0].toolPairRetention?.[0].retained).toBe(false);
      expect(results[1].calls[0].prompt).not.toContain("<tool_context>");
    }
  }
});

it("exports selected call inputs and resolved outcomes beside corpus messages", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".tool-corpus-"));
  const db = new DatabaseSync(join(dir, "corpus.sqlite"));
  try {
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("export");
    const records = await store.createMessagesBulk(buildSyntheticSession().messages.map(message => ({
      ...message, conversationId: conversation.conversationId,
    })));
    db.prepare(`INSERT INTO transcript_tool_calls
      (session_id, call_id, message_id, name, input, outcome, block_reason)
      VALUES ('export', 'blocked', ?, 'Bash', 'npm install old', 'blocked', 'Hook refuses installs')`)
      .run(records[0].messageId);
    db.prepare(`INSERT INTO transcript_tool_calls
      (session_id, call_id, message_id, name, input, outcome)
      VALUES ('export', 'fixed', ?, 'Bash', 'npm install new', 'succeeded')`).run(records[1].messageId);
    execFileSync("bash", [join(import.meta.dirname, "bench/export-eval-session.sh"), join(dir, "corpus.sqlite"),
      String(conversation.conversationId), join(dir, "export.json")]);
    const [session] = loadCorpusDir(dir);
    expect(session.messages[0].toolCalls).toEqual([{
      callId: "blocked", name: "Bash", input: "npm install old", outcome: "blocked",
      blockReason: "Hook refuses installs", truncated: false,
    }]);
    const prompts: string[] = [];
    const result = await runEval({ session, model: "fake", provider: "fake", run: 1,
      summarizer: async (text, aggressive, ctx = {}) => {
        prompts.push(buildSummaryPrompt(text, aggressive, ctx));
        return "npm install old blocked; npm install new worked.\nFiles: none\nExpand for details about: build";
      },
    });
    expect(result.calls[0].toolPairRetention?.[0].retained).toBe(true);
    expect(prompts[0]).toContain("Hook refuses installs");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("provides a planted failure corpus for the live evaluation", async () => {
  const session = buildSyntheticSession({ toolFailures: true });
  const prompts: string[] = [];
  const result = await runEval({ session, model: "fake", provider: "fake", run: 1,
    summarizer: async (text, aggressive, ctx = {}) => {
      prompts.push(buildSummaryPrompt(text, aggressive, ctx));
      return "npm install legacy-widget failed; npm install current-widget worked.\nFiles: none\nExpand for details about: build";
    },
  });
  expect(result.label).toBe("synthetic-tool-failures");
  expect(result.calls[0].toolPairRetention?.[0].retained).toBe(true);
  expect(result.calls[0].toolContext?.blocked).toEqual([{
    command: "make deploy", reason: "PreToolUse:Bash hook error: deployments are disabled",
  }]);
  expect(result.calls[0].toolContext?.errorFixPairs).toEqual([{
    failedCommand: "npm install legacy-widget", succeededCommand: "npm install current-widget",
  }]);
  expect(prompts[0]).toContain('"command":"make deploy"');
  expect(prompts[0]).toContain("deployments are disabled");
});
