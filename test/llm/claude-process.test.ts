import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeProcessSummarizer } from "../../src/llm/claude-process.js";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };

/** A `claude --print --output-format json` process that prints `result` and exits with `exitCode`. */
function makeChild(result: Record<string, unknown>, exitCode = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("finish", () => {
    child.stdout.end(JSON.stringify(result));
    child.stdout.on("end", () => setImmediate(() => child.emit("close", exitCode)));
    child.stdout.resume();
  });
  return child;
}

const ANSWER = { type: "result", is_error: false, result: "a summary", duration_ms: 5200, duration_api_ms: 4100,
  usage: { output_tokens: 300, output_tokens_details: { thinking_tokens: 0 } },
  modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 900, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };

describe("createClaudeProcessSummarizer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("turns off extended thinking and drops the inherited effort level", async () => {
    vi.stubEnv("CLAUDE_EFFORT", "xhigh");
    vi.stubEnv("MAX_THINKING_TOKENS", "32000");
    const spawn = vi.fn(() => makeChild(ANSWER));
    expect(await createClaudeProcessSummarizer({ spawn: spawn as any })("text to summarize")).toBe("a summary");
    const env = (spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(env.MAX_THINKING_TOKENS).toBe("0");
    expect(env).not.toHaveProperty("CLAUDE_EFFORT");
    expect(env.PATH ?? env.Path).toBeDefined();
    expect(process.env.CLAUDE_EFFORT).toBe("xhigh");
  });

  it("reports each call's timing, failed and timed-out calls included", async () => {
    const timings: unknown[] = [];
    const onCallTiming = (timing: unknown) => timings.push(timing);
    await createClaudeProcessSummarizer({ spawn: (() => makeChild(ANSWER)) as any })("text", false, { onCallTiming });
    await expect(createClaudeProcessSummarizer({ spawn: (() => makeChild({ ...ANSWER, is_error: true }, 1)) as any })("text", false, { onCallTiming }))
      .rejects.toThrow("claude exited 1");
    const hung = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    await expect(createClaudeProcessSummarizer({ spawn: (() => hung) as any, timeoutMs: 20 })("text", false, { onCallTiming }))
      .rejects.toThrow("timed out");
    expect(timings).toEqual([
      { provider: "claude-process", model: "claude-haiku-4-5-20251001", outcome: "ok", wallMs: expect.any(Number),
        durationMs: 5200, durationApiMs: 4100, inputTokens: 900, outputTokens: 300, thinkingTokens: 0 },
      expect.objectContaining({ outcome: "error", durationMs: 5200 }),
      expect.objectContaining({ outcome: "timeout", durationMs: undefined }),
    ]);
  });
});
