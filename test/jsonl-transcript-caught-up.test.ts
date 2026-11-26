import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claudeTranscriptCaughtUp, readClaudeTranscriptDelta } from "../src/claude-transcript-reader.js";
import type { JsonlTranscriptCursor } from "../src/jsonl-transcript-reader.js";

let dir: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const line = (content: string) => JSON.stringify({ message: { role: "user", content } }) + "\n";

/** A transcript and the cursor a full read of it leaves behind. */
async function fixture(): Promise<{ path: string; cursor: JsonlTranscriptCursor }> {
  dir = mkdtempSync(join(tmpdir(), "lcm-caught-up-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, line("first") + line("second"));
  const { cursor } = await readClaudeTranscriptDelta(path, { includeTrailingRecord: true });
  return { path, cursor };
}

it("accepts the cursor a read left at the end of an unchanged transcript", async () => {
  const { path, cursor } = await fixture();
  expect(await claudeTranscriptCaughtUp(path, cursor)).toBe(true);
});

it("rejects a transcript that grew past the cursor", async () => {
  const { path, cursor } = await fixture();
  appendFileSync(path, line("third"));
  expect(await claudeTranscriptCaughtUp(path, cursor)).toBe(false);
});

it("rejects a same-size rewrite of the consumed bytes", async () => {
  const { path, cursor } = await fixture();
  writeFileSync(path, line("FIRST") + line("second"));
  expect(await claudeTranscriptCaughtUp(path, cursor)).toBe(false);
});

it("rejects a cursor taken on another device or file", async () => {
  const { path, cursor } = await fixture();
  expect(await claudeTranscriptCaughtUp(path, { ...cursor, device: `${cursor.device}1` })).toBe(false);
  expect(await claudeTranscriptCaughtUp(path, { ...cursor, inode: `${cursor.inode}1` })).toBe(false);
});

it("compares file ids past 2^53 as strings, where two ids share one Number", async () => {
  const { path, cursor } = await fixture();
  const large = 2n ** 60n + 1n;
  const neighbour = large - 1n;
  expect(Number(neighbour)).toBe(Number(large));
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const realStat = prototype.stat;
  // NTFS-sized file ids on any file system: only the reported inode changes.
  vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle) {
    const stats = await realStat.call(this, { bigint: true });
    return Object.assign(stats, { ino: large });
  });

  expect(await claudeTranscriptCaughtUp(path, { ...cursor, inode: large.toString() })).toBe(true);
  expect(await claudeTranscriptCaughtUp(path, { ...cursor, inode: neighbour.toString() })).toBe(false);
});

it("throws when the transcript is gone, so a caller can count it", async () => {
  const { path, cursor } = await fixture();
  rmSync(path);
  await expect(claudeTranscriptCaughtUp(path, cursor)).rejects.toThrow();
});
