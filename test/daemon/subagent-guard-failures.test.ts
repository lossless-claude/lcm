import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectDbPath, projectDir } from "../../src/daemon/project.js";
import {
  forgetSubagentGuardSession, rememberSubagentGuard, skipUnchangedSubagentGuard, stalledSubagentGuards, subagentGuardFingerprint,
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
});
