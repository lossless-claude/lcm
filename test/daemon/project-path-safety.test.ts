import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeTranscriptPath } from "../../src/daemon/project.js";

describe("isSafeTranscriptPath", () => {
  let fixture: string;
  let cwd: string;

  beforeAll(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), "lcm-path-safety-")));
    cwd = join(fixture, "project");
    const home = join(fixture, "home");
    for (const directory of [cwd, join(home, ".claude", "projects"),
      join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")]) {
      mkdirSync(directory, { recursive: true });
    }
    vi.stubEnv("HOME", home);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  });

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
