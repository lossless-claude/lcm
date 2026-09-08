import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptPath } from "../../src/daemon/project.js";

describe("claudeTranscriptPath", () => {
  it("maps cwd and session id to Claude Code's transcript file", () => {
    expect(claudeTranscriptPath("/Users/pedro/Developer/lcm", "4f906b13-2426-4ae1-9f8a-0ec007952fa8")).toBe(
      join(homedir(), ".claude", "projects", "-Users-pedro-Developer-lcm", "4f906b13-2426-4ae1-9f8a-0ec007952fa8.jsonl"),
    );
  });

  it("replaces every non-alphanumeric character in the cwd, not only slashes", () => {
    expect(claudeTranscriptPath("/tmp/a.b_c/-x", "s1")).toBe(
      join(homedir(), ".claude", "projects", "-tmp-a-b-c--x", "s1.jsonl"),
    );
  });

  it("refuses a session id that is not a plain file name", () => {
    expect(claudeTranscriptPath("/tmp", "../etc/passwd")).toBeNull();
    expect(claudeTranscriptPath("/tmp", "a/b")).toBeNull();
  });
});
