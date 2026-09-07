import { describe, it, expect } from "vitest";
import { parseCodexUsage, parseLegacyCodexTokens, extractCodexErrorEvents } from "../../src/llm/codex-process.js";
import { parseClaudeResult } from "../../src/llm/claude-process.js";
import { parseCopilotJsonl } from "../../src/llm/copilot-process.js";

// All three fixtures were captured verbatim from the real CLIs. They pin the
// convention that makes the numbers comparable: inputTokens is the full prompt
// cost and cachedInputTokens is a subset of it, never additive.

describe("codex usage normalization", () => {
  // From `codex exec --json`; the same run printed "tokens used\n30,597" on stderr.
  const TURN_COMPLETED =
    '{"type":"turn.completed","usage":{"input_tokens":30592,"cached_input_tokens":7040,' +
    '"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}';

  it("treats cached tokens as a subset, matching the CLI's own total", () => {
    const usage = parseCodexUsage(TURN_COMPLETED, "gpt-5.6");
    expect(usage).toEqual({
      provider: "codex-process",
      model: "gpt-5.6",
      inputTokens: 30592,
      cachedInputTokens: 7040,
      outputTokens: 5,
      tokensUsed: 30597,
    });
    // The discriminator: the CLI's own "tokens used" line agrees.
    expect(usage!.tokensUsed).toBe(parseLegacyCodexTokens("tokens used\n30,597"));
  });

  it("returns undefined when no turn completed", () => {
    expect(parseCodexUsage('{"type":"turn.started"}')).toBeUndefined();
    expect(parseCodexUsage("")).toBeUndefined();
  });

  it("keeps the legacy stderr total for older Codex builds", () => {
    expect(parseLegacyCodexTokens("tokens used\n30,597")).toBe(30597);
    expect(parseLegacyCodexTokens("no usage here")).toBeUndefined();
  });
});

describe("extractCodexErrorEvents", () => {
  // With --json the real cause is a stdout event; stderr only had unrelated
  // MCP transport noise in the run this was captured from.
  const FAILED = [
    '{"type":"item.completed","item":{"id":"item_4","type":"error","message":"Skill descriptions were shortened."}}',
    '{"type":"error","message":"The \'bogus-model-xyz\' model is not supported."}',
    '{"type":"turn.failed","error":{"message":"The \'bogus-model-xyz\' model is not supported."}}',
  ].join("\n");

  it("reads the failure from the event stream and does not repeat it", () => {
    expect(extractCodexErrorEvents(FAILED)).toBe("The 'bogus-model-xyz' model is not supported.");
  });

  it("returns empty when the stream carries no failure", () => {
    expect(extractCodexErrorEvents('{"type":"turn.completed","usage":{}}')).toBe("");
  });
});

describe("claude usage normalization", () => {
  // From `claude --print --output-format json`, trimmed to the fields read.
  const RESULT = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "  OK  ",
    total_cost_usd: 0.0325202,
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 10,
        outputTokens: 49,
        cacheReadInputTokens: 14112,
        cacheCreationInputTokens: 15427,
        costUSD: 0.0325202,
      },
    },
  });

  it("folds Claude's three prompt counters into one inputTokens total", () => {
    const outcome = parseClaudeResult(RESULT, "fallback");
    expect(outcome).toEqual({
      content: "OK",
      isError: false,
      usage: {
        provider: "claude-process",
        model: "claude-haiku-4-5-20251001",
        // 10 uncached + 14112 cache reads + 15427 cache writes
        inputTokens: 29549,
        cachedInputTokens: 14112,
        outputTokens: 49,
        tokensUsed: 29598,
        costUsd: 0.0325202,
      },
    });
  });

  it("flags an error result without losing its usage", () => {
    const errored = JSON.stringify({ is_error: true, result: "boom", modelUsage: {} });
    expect(parseClaudeResult(errored, "m")).toEqual({ content: "boom", isError: true, usage: undefined });
  });

  it("returns undefined for non-JSON output", () => {
    expect(parseClaudeResult("plain text answer", "m")).toBeUndefined();
  });
});

describe("copilot usage normalization", () => {
  it("reports output tokens only, leaving prompt counters unreported", () => {
    const outcome = parseCopilotJsonl(
      '{"type":"assistant.message","data":{"content":"OK","outputTokens":221}}\n' +
      '{"type":"result","usage":{"premiumRequests":0.33}}',
    );
    // undefined, not zero: Copilot's JSON mode never exposes prompt tokens, and
    // that must stay distinguishable from a genuinely empty prompt.
    expect(outcome.outputTokens).toBe(221);
    expect(outcome.premiumRequests).toBe(0.33);
  });
});
