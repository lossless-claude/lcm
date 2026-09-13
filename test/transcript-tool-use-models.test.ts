import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractToolUseModels } from "../src/transcript.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Writes transcript entries as Claude Code does, one JSON object per line. */
function transcript(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-tool-models-"));
  tempDirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

describe("extractToolUseModels", () => {
  it("maps each tool_use block's id to the assistant message's model", () => {
    const path = transcript([
      { message: { role: "user", content: "commit this" } },
      {
        message: {
          role: "assistant", model: "claude-sonnet-5",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git commit -m x" } },
          ],
        },
      },
    ]);

    expect(extractToolUseModels(path)).toEqual(new Map([["toolu_1", "claude-sonnet-5"]]));
  });

  it("keeps one id per tool_use across several assistant turns with different models", () => {
    const path = transcript([
      { message: { role: "assistant", model: "model-a", content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
      { message: { role: "user", content: "ok" } },
      { message: { role: "assistant", model: "model-b", content: [{ type: "tool_use", id: "t2", name: "Bash" }] } },
    ]);

    expect(extractToolUseModels(path)).toEqual(new Map([["t1", "model-a"], ["t2", "model-b"]]));
  });

  it("ignores assistant turns with no model and turns with no tool_use blocks", () => {
    const path = transcript([
      { message: { role: "assistant", content: [{ type: "text", text: "no tools here" }] } },
      { message: { role: "assistant", model: "model-a", content: "plain text, no blocks" } },
    ]);

    expect(extractToolUseModels(path).size).toBe(0);
  });

  it("returns an empty map for an unreadable transcript", () => {
    expect(extractToolUseModels("/does/not/exist.jsonl").size).toBe(0);
  });
});
