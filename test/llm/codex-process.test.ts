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
  queueMicrotask(() => child.emit("close", exitCode));
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
