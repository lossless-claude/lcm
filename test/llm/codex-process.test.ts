import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createCodexProcessSummarizer } from "../../src/llm/codex-process.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(exitCode = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  // Emit close only after stderr has flushed, mirroring real spawned processes
  // (queueMicrotask would fire close before Node 22 delivers buffered data).
  // Tests that write to stderr call .end() themselves; for tests that never
  // touch stderr, end it on the next tick so close still fires.
  child.stderr.on("end", () => setImmediate(() => child.emit("close", exitCode)));
  queueMicrotask(() => {
    if (!child.stderr.writableEnded && !child.stderr.destroyed) {
      child.stderr.end();
    }
  });
  return child;
}

describe("createCodexProcessSummarizer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawns codex exec with read-only sandbox and writes the prompt to stdin", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    let stdin = "";
    child.stdin.on("data", (chunk) => {
      stdin += chunk.toString();
    });
    const mkdtempSyncMock = vi.fn(() => {
      const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
      tempDirs.push(dir);
      return dir;
    });
    const readFileSyncMock = vi.fn(() => "summary text");
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: mkdtempSyncMock as any,
      readFileSync: readFileSyncMock as any,
      rmSync: vi.fn() as any,
    });

    const promise = summarizer("Conversation text", false, { isCondensed: false });
    await expect(promise).resolves.toBe("summary text");

    expect(spawn).toHaveBeenCalledOnce();
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe("codex");
    expect(args).toContain("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("--output-last-message");
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(stdin).toContain("context-compaction summarization engine");
    expect(stdin).toContain("Conversation text");
  });

  it("passes --model when configured", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const readFileSyncMock = vi.fn(() => "summary text");
    const summarizer = createCodexProcessSummarizer({
      model: "gpt-5.4",
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: readFileSyncMock as any,
      rmSync: vi.fn() as any,
    });

    const promise = summarizer("Conversation text", false, { isCondensed: false });
    await expect(promise).resolves.toBe("summary text");

    expect(spawn.mock.calls[0][1]).toContain("--model");
    expect(spawn.mock.calls[0][1]).toContain("gpt-5.4");
  });

  it("reports token usage parsed from stderr", async () => {
    const child = makeChild(0);
    child.stderr.write("tokens used\n36,100\n");
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const onUsage = vi.fn();
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: vi.fn(() => "summary text") as any,
      rmSync: vi.fn() as any,
    });

    await expect(
      summarizer("Conversation text", false, { isCondensed: false, onUsage }),
    ).resolves.toBe("summary text");
    expect(onUsage).toHaveBeenCalledWith({
      provider: "codex-process",
      model: undefined,
      tokensUsed: 36100,
    });
  });

  it("returns a friendly ENOENT error when codex is missing", async () => {
    const summarizer = createCodexProcessSummarizer({
      spawn: vi.fn(() => {
        const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as any,
      mkdtempSync: vi.fn(() => mkdtempSync(join(tmpdir(), "lossless-codex-"))) as any,
      readFileSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      tmpdir: () => tmpdir(),
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow(
      "Codex CLI is not installed or not on PATH",
    );
  });

  it("rejects on non-zero exit", async () => {
    const child = makeChild(1);
    child.stderr.write("boom");
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const readFileSyncMock = vi.fn(() => "summary text");
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: readFileSyncMock as any,
      rmSync: vi.fn() as any,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow("codex exited 1");
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  const CODEX_BANNER = [
    "OpenAI Codex v0.153.4",
    "--------",
    "workdir: /Users/someone/project",
    "model: gpt-5.3-codex-spark",
    "provider: openai",
    "approval: on-request",
    "sandbox: read-only",
    "reasoning effort: medium",
    "reasoning summaries: none",
    "session id: 3f8e2c1a-0000-0000-0000-abcdef012345",
    "",
  ].join("\n");

  it("skips the codex stderr banner so the real error is visible", async () => {
    const child = makeChild(1);
    child.stderr.write(CODEX_BANNER);
    child.stderr.write("Error: stream disconnected before completion\n");
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: vi.fn(() => "summary text") as any,
      rmSync: vi.fn() as any,
    });

    let error: Error | undefined;
    try {
      await summarizer("Conversation text", false);
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain("codex exited 1");
    expect(error!.message).toContain("Error: stream disconnected before completion");
    expect(error!.message).not.toContain("OpenAI Codex v0.153.4");
    expect(error!.message).not.toContain("workdir:");
  });

  it("reports 'no output' when stderr is only the codex banner", async () => {
    const child = makeChild(1);
    child.stderr.write(CODEX_BANNER);
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: vi.fn() as any,
      rmSync: vi.fn() as any,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow(
      "codex exited 1: no output",
    );
  });

  it("keeps the tail of stderr when it exceeds the error excerpt limit", async () => {
    const child = makeChild(1);
    child.stderr.write(CODEX_BANNER);
    child.stderr.write("noise line\n".repeat(500));
    child.stderr.write("ERROR: the real failure reason is here\n");
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: vi.fn() as any,
      rmSync: vi.fn() as any,
    });

    let error: Error | undefined;
    try {
      await summarizer("Conversation text", false);
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain("ERROR: the real failure reason is here");
    expect(error!.message).toContain("[...]");
    expect(error!.message.length).toBeLessThan(2_200);
  });

  it("surfaces usage-limit failures with an actionable message", async () => {
    const child = makeChild(1);
    child.stderr.write(CODEX_BANNER);
    child.stderr.write("ERROR: You have hit your usage limit. Try again later.\n");
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: vi.fn() as any,
      rmSync: vi.fn() as any,
    });

    let error: Error | undefined;
    try {
      await summarizer("Conversation text", false);
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain("usage limit");
    expect(error!.message).toContain("wait for the limit to reset or switch models");
    expect(error!.message).toContain("You have hit your usage limit");
  });

  it("reports token usage even on non-zero exit", async () => {
    const child = makeChild(1);
    child.stderr.write("tokens used\n35,576\n");
    child.stderr.write("ERROR: failure\n");
    child.stderr.end();
    const spawn = vi.fn().mockReturnValue(child);
    const onUsage = vi.fn();
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: vi.fn() as any,
      rmSync: vi.fn() as any,
    });

    await expect(summarizer("Conversation text", false, { onUsage })).rejects.toThrow("codex exited 1");
    expect(onUsage).toHaveBeenCalledWith({
      provider: "codex-process",
      model: undefined,
      tokensUsed: 35576,
    });
  });

  it("rejects when the output file is empty", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const readFileSyncMock = vi.fn(() => "");
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as any,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as any,
      readFileSync: readFileSyncMock as any,
      rmSync: vi.fn() as any,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow("codex output was empty");
  });
});
