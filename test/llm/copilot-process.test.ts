import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  createCopilotProcessSummarizer,
  parseCopilotJsonl,
  buildCopilotArgs,
} from "../../src/llm/copilot-process.js";

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

// Captured verbatim from `copilot -p ... --output-format json` (CLI 1.0.18).
const REAL_JSONL = [
  '{"type":"assistant.message_delta","data":{"messageId":"m1","deltaContent":"OK"},"ephemeral":true}',
  '{"type":"assistant.message","data":{"messageId":"m1","content":"OK","toolRequests":[],"outputTokens":221}}',
  '{"type":"result","sessionId":"s1","exitCode":0,"usage":{"premiumRequests":0.33,"totalApiDurationMs":3290}}',
].join("\n");

describe("parseCopilotJsonl", () => {
  it("extracts the final message content and usage from real CLI output", () => {
    expect(parseCopilotJsonl(REAL_JSONL)).toEqual({
      content: "OK",
      outputTokens: 221,
      premiumRequests: 0.33,
    });
  });

  it("ignores unparseable and non-JSON lines", () => {
    const noisy = `not json\n{"broken":\n${REAL_JSONL}\n`;
    expect(parseCopilotJsonl(noisy).content).toBe("OK");
  });

  it("keeps the last assistant message and sums output tokens across turns", () => {
    const twoTurns = [
      '{"type":"assistant.message","data":{"content":"first","outputTokens":10}}',
      '{"type":"assistant.message","data":{"content":"second","outputTokens":5}}',
    ].join("\n");
    expect(parseCopilotJsonl(twoTurns)).toEqual({
      content: "second",
      outputTokens: 15,
      premiumRequests: undefined,
    });
  });

  it("returns empty content when the stream carries no message", () => {
    expect(parseCopilotJsonl("").content).toBe("");
  });
});

describe("buildCopilotArgs", () => {
  it("passes the prompt as an argv value and keeps the run hermetic", () => {
    const args = buildCopilotArgs("PROMPT");
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("PROMPT");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--no-custom-instructions");
    expect(args).toContain("--disable-builtin-mcps");
    // A bogus name, not an empty value: the CLI ignores --available-tools=
    // and would still hand the model bash.
    expect(args).toContain("--available-tools=__none__");
    expect(args).not.toContain("--available-tools=");
    expect(args).toContain("--no-ask-user");
    expect(args).not.toContain("--model");
  });

  it("appends --model when one is configured", () => {
    expect(buildCopilotArgs("PROMPT", " gpt-5.2 ")).toEqual(
      expect.arrayContaining(["--model", "gpt-5.2"]),
    );
  });
});

describe("createCopilotProcessSummarizer", () => {
  it("resolves with the message content and reports normalized usage", async () => {
    const child = makeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const onUsage = vi.fn();
    const summarizer = createCopilotProcessSummarizer({ model: "gpt-5.2", spawn: spawn as any });

    const promise = summarizer("Conversation text", false, { onUsage });
    finish(child, 0, REAL_JSONL);

    await expect(promise).resolves.toBe("OK");
    expect(spawn.mock.calls[0][0]).toBe("copilot");
    expect(onUsage).toHaveBeenCalledWith({
      provider: "copilot-process",
      model: "gpt-5.2",
      // Copilot's JSONL stream carries no prompt-token counts.
      outputTokens: 221,
      tokensUsed: 221,
      premiumRequests: 0.33,
    });
  });

  it("still reports usage when the process exits non-zero", async () => {
    const child = makeChild();
    const onUsage = vi.fn();
    const summarizer = createCopilotProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text", false, { onUsage });
    finish(child, 1, REAL_JSONL, "boom");

    await expect(promise).rejects.toThrow(/copilot exited 1: boom/);
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("recognizes quota exhaustion and says how to recover", async () => {
    const child = makeChild();
    const summarizer = createCopilotProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 1, "", "You have exceeded your premium request quota");

    await expect(promise).rejects.toThrow(/copilot usage limit reached/);
  });

  it("falls back to JSONL error events when stderr is empty", async () => {
    const child = makeChild();
    const summarizer = createCopilotProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 1, '{"type":"error","data":{"message":"model unavailable"}}');

    await expect(promise).rejects.toThrow(/copilot exited 1: model unavailable/);
  });

  it("rejects an empty answer on a successful exit", async () => {
    const child = makeChild();
    const summarizer = createCopilotProcessSummarizer({ spawn: vi.fn().mockReturnValue(child) as any });

    const promise = summarizer("text");
    finish(child, 0, '{"type":"result","exitCode":0,"usage":{"premiumRequests":0.33}}');

    await expect(promise).rejects.toThrow(/copilot output was empty/);
  });

  it("rejects oversized prompts instead of overflowing argv", async () => {
    const spawn = vi.fn();
    const summarizer = createCopilotProcessSummarizer({ spawn: spawn as any });

    await expect(summarizer("x".repeat(300_000))).rejects.toThrow(/over the 200000-byte limit/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("explains how to install the CLI when it is missing", async () => {
    const spawn = vi.fn(() => {
      throw Object.assign(new Error("spawn copilot ENOENT"), { code: "ENOENT" });
    });
    const summarizer = createCopilotProcessSummarizer({ spawn: spawn as any });

    await expect(summarizer("text")).rejects.toThrow(/npm install -g @github\/copilot/);
  });

  it("kills the process and rejects on timeout", async () => {
    const child = makeChild();
    const summarizer = createCopilotProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as any,
      timeoutMs: 5,
    });

    await expect(summarizer("text")).rejects.toThrow(/timed out after 0s/);
    expect(child.kill).toHaveBeenCalled();
  });
});
