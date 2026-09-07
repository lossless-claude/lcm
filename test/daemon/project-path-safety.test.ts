import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSafeTranscriptPath } from "../../src/daemon/project.js";

describe("isSafeTranscriptPath", () => {
  const cwd = "/tmp";

  it("allows paths under ~/.claude/projects/", () => {
    const p = join(homedir(), ".claude", "projects", "test-project", "abc.jsonl");
    expect(isSafeTranscriptPath(p, cwd)).toBeTruthy();
  });

  it("allows paths under the project cwd", () => {
    expect(isSafeTranscriptPath(join(cwd, "transcript.jsonl"), cwd)).toBeTruthy();
  });

  it("allows only Codex transcript roots when explicitly selected", () => {
    for (const root of ["sessions", "archived_sessions"]) {
      const p = join(homedir(), ".codex", root, "2026", "09", "rollout.jsonl");
      expect(isSafeTranscriptPath(p, cwd, "codex")).toBeTruthy();
      expect(isSafeTranscriptPath(p, cwd)).toBe(false);
    }
    expect(isSafeTranscriptPath(join(homedir(), ".codex", "auth.json"), cwd, "codex")).toBe(false);
    expect(isSafeTranscriptPath(join(homedir(), ".codex", "sessions", "..", "auth.json"), cwd, "codex")).toBe(false);
  });

  it("rejects paths outside allowed bases", () => {
    expect(isSafeTranscriptPath("/etc/passwd", cwd)).toBe(false);
    expect(isSafeTranscriptPath(join(homedir(), ".ssh", "id_rsa"), cwd)).toBe(false);
  });

  it("rejects path traversal via ../", () => {
    const base = join(homedir(), ".claude", "projects");
    expect(isSafeTranscriptPath(join(base, "..", "..", ".ssh", "id_rsa"), cwd)).toBe(false);
  });

  it("returns the normalized path string on success", () => {
    const p = join(homedir(), ".claude", "projects", "test", "session.jsonl");
    const result = isSafeTranscriptPath(p, cwd);
    expect(typeof result).toBe("string");
  });
});
