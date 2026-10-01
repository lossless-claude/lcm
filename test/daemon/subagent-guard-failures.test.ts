import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDbPath, projectDir } from "../../src/daemon/project.js";
import {
  clearTerminalTranscriptGuards, forgetSubagentGuardSession, rememberSubagentGuard, skipUnchangedSubagentGuard, stalledSubagentGuards, subagentGuardFingerprint,
} from "../../src/daemon/subagent-guard-failures.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("subagent guard failures", () => {
  it("forgets a session's recorded failure once it is rebuilt, so it is neither skipped nor listed", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-subagent-guard-"));
    roots.push(root);
    const paths = createLcmPaths(join(root, "lcm"));
    const cwd = join(root, "work");
    mkdirSync(projectDir(cwd, paths), { recursive: true });
    writeFileSync(projectDbPath(cwd, paths), "");
    const transcript = join(root, "agent-1.jsonl");
    writeFileSync(transcript, "{}\n");
    const fingerprint = subagentGuardFingerprint(transcript);

    rememberSubagentGuard(cwd, paths, transcript, fingerprint, "agent-1", "parent", "prefix differs");
    expect(skipUnchangedSubagentGuard(cwd, paths, transcript, fingerprint)).toBe(true);
    expect(stalledSubagentGuards(cwd, paths)).toHaveLength(1);

    forgetSubagentGuardSession(cwd, paths, "agent-1");
    expect(skipUnchangedSubagentGuard(cwd, paths, transcript, fingerprint)).toBe(false);
    expect(stalledSubagentGuards(cwd, paths)).toEqual([]);
  });

  it("keeps retrying a failure it could not record for doctor", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-subagent-guard-"));
    roots.push(root);
    const paths = createLcmPaths(join(root, "lcm"));
    const cwd = join(root, "work");
    mkdirSync(projectDir(cwd, paths), { recursive: true });
    writeFileSync(projectDbPath(cwd, paths), "");
    // The sidecar path is a directory, so the atomic rename cannot replace it.
    mkdirSync(join(projectDir(cwd, paths), "subagent-guard-failures.json"));
    const transcript = join(root, "agent-2.jsonl");
    writeFileSync(transcript, "{}\n");
    const fingerprint = subagentGuardFingerprint(transcript);

    rememberSubagentGuard(cwd, paths, transcript, fingerprint, "agent-2", "parent", "prefix differs");
    expect(skipUnchangedSubagentGuard(cwd, paths, transcript, fingerprint)).toBe(false);
  });

  it("clears only the selected project's terminal Codex guards", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-clear-guards-"));
    roots.push(root);
    const paths = createLcmPaths(join(root, "lcm"));
    const cwds = [join(root, "work"), join(root, "other")];
    for (const cwd of cwds) {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(projectDir(cwd, paths), { recursive: true });
      writeFileSync(projectDbPath(cwd, paths), "");
      for (const session of ["one", "two", "claude"]) {
        const path = join(cwd, `${session}.jsonl`);
        writeFileSync(path, "{}\n");
        rememberSubagentGuard(cwd, paths, path, subagentGuardFingerprint(path), session, "parent", "differs",
          session === "claude" ? {} : { client: "codex", terminal: true });
      }
    }
    expect(clearTerminalTranscriptGuards(cwds[0], paths, "one")).toBe(1);
    expect(stalledSubagentGuards(cwds[0], paths).map(row => row.failure.sessionId)).toEqual(["two", "claude"]);
    expect(stalledSubagentGuards(cwds[1], paths)).toHaveLength(3);
    expect(clearTerminalTranscriptGuards(cwds[0], paths)).toBe(1);
    expect(stalledSubagentGuards(cwds[0], paths).map(row => row.failure.sessionId)).toEqual(["claude"]);
    expect(stalledSubagentGuards(cwds[1], paths)).toHaveLength(3);
    expect(clearTerminalTranscriptGuards(cwds[0], paths)).toBe(0);
  });

  it("retries an older recovery rule once and records a still-blocked session under the current rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-rule-guard-"));
    roots.push(root);
    const paths = createLcmPaths(join(root, "lcm"));
    const cwd = join(root, "work");
    mkdirSync(projectDir(cwd, paths), { recursive: true });
    writeFileSync(projectDbPath(cwd, paths), "");
    const transcript = join(root, "rollout.jsonl");
    writeFileSync(transcript, "{}\n");
    rememberSubagentGuard(cwd, paths, transcript, subagentGuardFingerprint(transcript), "child", "parent", "tail differs",
      { client: "codex", terminal: true });
    const sidecar = join(projectDir(cwd, paths), "subagent-guard-failures.json");
    const record = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(record.failures[transcript].recoveryRuleVersion).toEqual(expect.any(Number));
    record.failures[transcript].recoveryRuleVersion = 0;
    writeFileSync(sidecar, JSON.stringify(record));

    vi.resetModules();
    const fresh = await import("../../src/daemon/subagent-guard-failures.js");
    expect(fresh.terminalTranscriptGuard(cwd, paths, "child")).toBeUndefined();
    expect(fresh.stalledSubagentGuards(cwd, paths)).toEqual([]);
    fresh.rememberSubagentGuard(cwd, paths, transcript, subagentGuardFingerprint(transcript), "child", "parent", "still differs",
      { client: "codex", terminal: true });
    expect(fresh.terminalTranscriptGuard(cwd, paths, "child")).toMatchObject({ message: "still differs" });
    const rerecorded = readFileSync(sidecar, "utf8");
    fresh.rememberSubagentGuard(cwd, paths, join(root, "moved.jsonl"), undefined, "child", "parent", "duplicate",
      { client: "codex", terminal: true });
    expect(readFileSync(sidecar, "utf8")).toBe(rerecorded);
    expect(fresh.stalledSubagentGuards(cwd, paths)).toHaveLength(1);
  });

  it("loads terminal guards in a fresh process state across upgrades and file removal, bound to the database", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-terminal-guard-"));
    roots.push(root);
    const paths = createLcmPaths(join(root, "lcm"));
    const cwd = join(root, "work");
    mkdirSync(projectDir(cwd, paths), { recursive: true });
    const dbPath = projectDbPath(cwd, paths);
    writeFileSync(dbPath, "");
    const transcript = join(root, "rollout.jsonl");
    writeFileSync(transcript, "{}\n");
    rememberSubagentGuard(cwd, paths, transcript, subagentGuardFingerprint(transcript), "child", "parent", "tail differs",
      { client: "codex", terminal: true });
    const sidecar = join(projectDir(cwd, paths), "subagent-guard-failures.json");
    const record = JSON.parse(readFileSync(sidecar, "utf8"));
    record.version = "older-version";
    writeFileSync(sidecar, JSON.stringify(record));
    renameSync(transcript, join(root, "moved.jsonl"));

    vi.resetModules();
    const fresh = await import("../../src/daemon/subagent-guard-failures.js");
    expect(fresh.terminalTranscriptGuard(cwd, paths, "child")).toMatchObject({ message: "tail differs" });
    expect(fresh.stalledSubagentGuards(cwd, paths)).toHaveLength(1);
    // Another path for the same session cannot overwrite the recorded evidence.
    fresh.rememberSubagentGuard(cwd, paths, join(root, "moved.jsonl"), undefined, "child", "parent", "another error",
      { client: "codex", terminal: true });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual(record);

    renameSync(dbPath, join(root, "old.db"));
    writeFileSync(dbPath, "");
    expect(fresh.terminalTranscriptGuard(cwd, paths, "child")).toBeUndefined();
    expect(fresh.stalledSubagentGuards(cwd, paths)).toEqual([]);
  });
});
