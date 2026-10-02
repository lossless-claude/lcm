import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readClaudeTranscriptDelta } from "../src/claude-transcript-reader.js";
import { CompactionDeadlineError } from "../src/compaction-deadline.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function transcript(rows: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "lcm-scan-bound-")); dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

it("bounds a resumed UUID lookup but finds a recent boundary in the bounded tail", async () => {
  const path = transcript([{ uuid: "old", message: { role: "user", content: "source" } },
    { type: "progress", padding: "x".repeat(2 * 1024 * 1024) }, { uuid: "recent", type: "progress" }]);
  const first = await readClaudeTranscriptDelta(path, { includeTrailingRecord: true });
  const old = await readClaudeTranscriptDelta(path, { cursor: first.cursor, includeTrailingRecord: true,
    recordMatches: record => JSON.parse(record).uuid === "old" });
  expect(old.recordMatched).toBe(false);
  expect(old.boundaryScanExceeded).toBe(true);
  const recent = await readClaudeTranscriptDelta(path, { cursor: first.cursor, includeTrailingRecord: true,
    recordMatches: record => JSON.parse(record).uuid === "recent" });
  expect(recent.recordMatched).toBe(true);
  expect(recent.boundaryScanExceeded).toBeFalsy();
});

it("preserves a deadline abort during record scanning rather than reporting invalid JSONL", async () => {
  const path = transcript([{ uuid: "first", message: { role: "user", content: "one" } },
    { uuid: "last", message: { role: "user", content: "two" } }]);
  const controller = new AbortController();
  const reason = new CompactionDeadlineError();
  await expect(readClaudeTranscriptDelta(path, { includeTrailingRecord: true, signal: controller.signal,
    recordMatches: () => { controller.abort(reason); return false; } })).rejects.toBe(reason);
});
