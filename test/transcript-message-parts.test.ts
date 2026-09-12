import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTranscript } from "../src/transcript.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Writes transcript entries as Claude Code does, one JSON object per line. */
function transcript(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-parts-"));
  tempDirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

const entry = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

const commandBlock = (name: string, args = "") =>
  `<command-name>${name}</command-name>\n            <command-message>x</command-message>\n            <command-args>${args}</command-args>`;

describe("skill and command parts", () => {
  it("records a Skill tool_use as a skill part, by its structured name", () => {
    const path = transcript([
      entry("assistant", [{ type: "tool_use", name: "Skill", input: { skill: "grilling" } }]),
    ]);
    const [message] = parseTranscript(path);
    expect(message.parts).toEqual([{ type: "skill", name: "grilling", args: null }]);
  });

  it("carries the Skill tool_use's args field when present", () => {
    const path = transcript([
      entry("assistant", [{ type: "tool_use", name: "Skill", input: { skill: "release-plugin", args: "autoimprove" } }]),
    ]);
    const [message] = parseTranscript(path);
    expect(message.parts).toEqual([{ type: "skill", name: "release-plugin", args: "autoimprove" }]);
  });

  it("does not treat an ordinary tool_use as a skill part", () => {
    const path = transcript([
      entry("assistant", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
    ]);
    const [message] = parseTranscript(path);
    expect(message.parts).toBeUndefined();
  });

  it("records a slash command block with args", () => {
    const path = transcript([entry("user", commandBlock("/goal", "monitora e roda os testes"))]);
    const [message] = parseTranscript(path);
    expect(message.parts).toEqual([{ type: "command", name: "/goal", args: "monitora e roda os testes" }]);
  });

  it("records a slash command block with no args as null, not empty string", () => {
    const path = transcript([entry("user", commandBlock("/model"))]);
    const [message] = parseTranscript(path);
    expect(message.parts).toEqual([{ type: "command", name: "/model", args: null }]);
  });

  it("does not turn a command block quoted inside a code fence into a part", () => {
    const path = transcript([
      entry("user", "Example:\n```\n" + commandBlock("/model") + "\n```\nthat's the format"),
    ]);
    const [message] = parseTranscript(path);
    expect(message.parts).toBeUndefined();
  });

  it("leaves parts undefined for a transcript with neither a skill nor a command", () => {
    const path = transcript([entry("user", "roda os testes")]);
    const [message] = parseTranscript(path);
    expect(message.parts).toBeUndefined();
  });
});
