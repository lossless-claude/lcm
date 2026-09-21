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

  it("allows only the OMP session root when explicitly selected, honoring PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const p = join(homedir(), ".omp", "agent", "sessions", "-work-project", "2026-09-20T10-00-00-000Z_sess.jsonl");
    expect(isSafeTranscriptPath(p, cwd, "omp")).toBeTruthy();
    expect(isSafeTranscriptPath(p, cwd)).toBe(false);
    // The daemon's own home and any other harness's roots are not OMP transcripts.
    expect(isSafeTranscriptPath(join(homedir(), ".omp", "agent", "config.yml"), cwd, "omp")).toBe(false);
    expect(isSafeTranscriptPath(join(homedir(), ".claude", "projects", "p", "s.jsonl"), cwd, "omp")).toBe(false);
  });

  it("allows an OMP agent dir relocated by PI_CODING_AGENT_DIR", () => {
    const relocated = join(fixture, "omp-agent");
    mkdirSync(join(relocated, "sessions", "-work-project"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", relocated);
    const p = join(relocated, "sessions", "-work-project", "session.jsonl");
    expect(isSafeTranscriptPath(p, cwd, "omp")).toBeTruthy();
    expect(isSafeTranscriptPath(join(homedir(), ".omp", "agent", "sessions", "-work-project", "session.jsonl"), cwd, "omp")).toBe(false);
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
  });

  it("allows an OMP profile's session root as well, so a profile hook is not silently refused", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const profile = join(homedir(), ".omp", "profiles", "work", "agent", "sessions", "-work-project");
    mkdirSync(profile, { recursive: true });
    expect(isSafeTranscriptPath(join(profile, "session.jsonl"), cwd, "omp")).toBeTruthy();
    expect(isSafeTranscriptPath(join(homedir(), ".omp", "profiles", "work", "agent", "config.yml"), cwd, "omp")).toBe(false);
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
