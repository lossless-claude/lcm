import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  createOmpProcessSummarizer,
  parseOmpTurnEnd,
  parseOmpUsage,
  buildOmpArgs,
} from "../../src/llm/omp-process.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

/** Feeds the streams, then closes, mirroring the ordering of a real process. */
function finish(child: FakeChild, exitCode: number, stdout = "", stderr = ""): void {
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    setImmediate(() => child.emit("close", exitCode));
  });
}

// Shaped from `omp --print --mode json`'s AgentEvent stream: a session header
// line followed by lifecycle events, the last `turn_end` carrying the final
// assistant message (content blocks + usage, matching pi-ai's Usage fields).
const TURN_END = [
  '{"sessionId":"s1"}',
  '{"type":"agent_start"}',
  '{"type":"turn_end","message":{"content":[{"type":"text","text":"OK"}],' +
    '"usage":{"input":120,"output":40,"cacheRead":30,"cacheWrite":0,"totalTokens":160},' +
    '"model":"claude-sonnet-5","stopReason":"stop"},"toolResults":[]}',
].join("\n");

describe("parseOmpTurnEnd", () => {
  it("reads the final assistant message from the event stream", () => {
    const message = parseOmpTurnEnd(TURN_END);
    expect(message?.content).toEqual([{ type: "text", text: "OK" }]);
    expect(message?.model).toBe("claude-sonnet-5");
  });

  it("ignores unparseable and non-JSON lines", () => {
    const noisy = `not json\n{"broken":\n${TURN_END}\n`;
    expect(parseOmpTurnEnd(noisy)?.content).toEqual([{ type: "text", text: "OK" }]);
  });

  it("keeps the last turn_end across several turns", () => {
    const twoTurns = [
      '{"type":"turn_end","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"turn_end","message":{"content":[{"type":"text","text":"second"}]}}',
    ].join("\n");
    expect(parseOmpTurnEnd(twoTurns)?.content).toEqual([{ type: "text", text: "second" }]);
  });

  it("returns undefined when the stream carries no turn_end", () => {
    expect(parseOmpTurnEnd('{"type":"agent_start"}')).toBeUndefined();
    expect(parseOmpTurnEnd("")).toBeUndefined();
  });
});

describe("parseOmpUsage", () => {
  it("treats cacheRead as a subset of input and totalTokens as the CLI's own sum", () => {
    expect(parseOmpUsage(TURN_END)).toEqual({
      provider: "omp-process",
      model: "claude-sonnet-5",
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 40,
      tokensUsed: 160,
    });
  });

  it("falls back to the configured model when the message reports none", () => {
    const noModel = '{"type":"turn_end","message":{"usage":{"input":1,"output":1,"totalTokens":2}}}';
    expect(parseOmpUsage(noModel, "fallback-model")?.model).toBe("fallback-model");
  });

  it("returns undefined when no turn_end carries usage", () => {
    expect(parseOmpUsage('{"type":"turn_end","message":{}}')).toBeUndefined();
    expect(parseOmpUsage("")).toBeUndefined();
  });
});

describe("buildOmpArgs", () => {
  it("keeps the run hermetic and ephemeral, with the prompt going via stdin", () => {
    const args = buildOmpArgs(undefined, "SYSTEM");
    expect(args).toContain("--print");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("json");
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-tools");
    expect(args).toContain("--no-lsp");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-rules");
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("SYSTEM");
    expect(args).not.toContain("--model");
  });

  it("appends --model when one is configured", () => {
    expect(buildOmpArgs(" opus ", "SYSTEM")).toEqual(expect.arrayContaining(["--model", "opus"]));
  });
});

describe("createOmpProcessSummarizer", () => {
  it("writes the prompt to stdin and resolves with the turn's text content", async () => {
    const child = makeChild();
    const spawn = vi.fn().mockReturnValue(child);
    let stdin = "";
    child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    const onUsage = vi.fn();
    const summarizer = createOmpProcessSummarizer({ model: "opus", spawn: spawn as any });

    const promise = summarizer("Conversation text", false, { onUsage, isCondensed: false });
    finish(child, 0, TURN_END);

    await expect(promise).resolves.toBe("OK");
    expect(spawn.mock.calls[0][0]).toBe("omp");
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--model", "opus"]));
    expect(onUsage).toHaveBeenCalledWith({
      provider: "omp-process",
      model: "claude-sonnet-5",
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 40,
      tokensUsed: 160,
    });
    await vi.waitFor(() => expect(stdin).toContain("Conversation text"));
  });

  it("rejects on non-zero exit, using the assistant's own error message", async () => {
    const child = makeChild();
    const summarizer = createOmpProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 1, '{"type":"turn_end","message":{"stopReason":"error","errorMessage":"model unavailable"}}');

    await expect(promise).rejects.toThrow("omp exited 1: model unavailable");
  });

  it("falls back to stderr when the failed turn carries no errorMessage", async () => {
    const child = makeChild();
    const summarizer = createOmpProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 1, "", "boom");

    await expect(promise).rejects.toThrow("omp exited 1: boom");
  });

  it("recognizes quota exhaustion and says how to recover", async () => {
    const child = makeChild();
    const summarizer = createOmpProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 1, "", "You have hit your usage limit");

    await expect(promise).rejects.toThrow(/omp usage limit reached/);
  });

  it("rejects an empty answer on a successful exit", async () => {
    const child = makeChild();
    const summarizer = createOmpProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 0, '{"type":"turn_end","message":{"content":[]}}');

    await expect(promise).rejects.toThrow("omp output was empty");
  });

  it("explains how to install the CLI when it is missing", async () => {
    const spawn = vi.fn(() => {
      throw Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" });
    });
    const summarizer = createOmpProcessSummarizer({ spawn: spawn as any });

    await expect(summarizer("text")).rejects.toThrow(/npm install -g @oh-my-pi\/pi-coding-agent/);
  });

  it("kills the process and rejects on timeout", async () => {
    const child = makeChild();
    const summarizer = createOmpProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as any,
      timeoutMs: 5,
    });

    await expect(summarizer("text")).rejects.toThrow(/timed out after 0s/);
    expect(child.kill).toHaveBeenCalled();
  });
});
