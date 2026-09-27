import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHookOutcomeLog } from "../../src/doctor/hook-outcome-log.js";
import { projectId } from "../../src/daemon/project.js";
import { observeHook } from "../../src/hooks/observe.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

describe("local command-hook outcome inspection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates a Session and deduplicates retained operation identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-hook-outcome-log-"));
    dirs.push(dir);
    const base = { ts: Date.now(), projectId: projectId("/project"), sessionId: "s1", harness: "codex",
      hook: "PreCompact", operation: "precompact", kind: "delivery", status: "accepted",
      reason: "", operationId: "op-1" };
    writeFileSync(join(dir, "hook-outcomes.log"), [
      JSON.stringify(base), JSON.stringify(base),
      JSON.stringify({ ...base, operationId: "op-2" }),
      JSON.stringify({ ...base, projectId: projectId("/other"), operationId: "op-3" }),
      JSON.stringify({ ...base, operationId: "op-4", status: "rejected", reason: "http-401" }),
    ].join("\n") + "\n");
    const result = readHookOutcomeLog(dir, "/project");
    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "s1", status: "accepted", count: 2 }),
      expect.objectContaining({ sessionId: "s1", status: "rejected", count: 1 }),
    ]));
    expect(result.failures).toMatchObject([{ status: "rejected", reason: "http-401" }]);
    expect(result.truncated).toBe(false);
  });

  it("keeps one entry bounded and stores only the project hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-hook-outcome-writer-"));
    dirs.push(dir);
    const paths = createLcmPaths(dir);
    const observation = { sessionId: "s1", harness: "codex" as const, hook: "Stop",
      operation: "capture", kind: "delivery" as const, status: "accepted" as const };
    expect(observeHook("x".repeat(3 * 1024 * 1024), observation, paths)).toBe(false);
    expect(observeHook(42 as unknown as string, observation, paths)).toBe(false);
    expect(existsSync(join(paths.logsDir, "hook-outcomes.log"))).toBe(false);
    expect(observeHook(dir, observation, paths)).toBe(true);
    expect(readFileSync(join(paths.logsDir, "hook-outcomes.log"), "utf8")).not.toContain(dir);
    expect(readHookOutcomeLog(paths.logsDir, dir).outcomes).toMatchObject([
      { sessionId: "s1", status: "accepted", count: 1 },
    ]);
  });

  it("does not replace the retained log while another hook owns rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-hook-outcome-rotation-"));
    dirs.push(dir);
    const paths = createLcmPaths(dir);
    mkdirSync(paths.logsDir, { recursive: true });
    const log = join(paths.logsDir, "hook-outcomes.log");
    const lock = `${log}.rotate.lock`;
    writeFileSync(log, "x".repeat(2 * 1024 * 1024));
    writeFileSync(lock, "");
    const observation = { sessionId: "s1", harness: "codex" as const, hook: "Stop",
      operation: "capture", kind: "delivery" as const, status: "accepted" as const };

    expect(observeHook(dir, observation, paths)).toBe(false);
    expect(existsSync(`${log}.1`)).toBe(false);
    expect(statSync(log).size).toBe(2 * 1024 * 1024);
    rmSync(lock);
    expect(observeHook(dir, observation, paths)).toBe(true);
    expect(statSync(`${log}.1`).size).toBe(2 * 1024 * 1024);
    expect(observeHook(dir, observation, paths)).toBe(true);
    expect(statSync(`${log}.1`).size).toBe(2 * 1024 * 1024);
  });
});
