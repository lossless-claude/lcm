import { dispatchHook } from "../../src/hooks/dispatch.js";
import { describe, expect, it, vi } from "vitest";
import { workerHookOwner } from "../../src/hooks/worker-owner.js";

describe("worker hook process ownership", () => {
  it.each(["claude", "codex"] as const)("keeps the %s owner stable across separate hook shell processes", client => {
    const read = (pid: number) => pid === 100
      ? { parent: 1, executable: `/bin/${client}`, startedAt: "stable-start" }
      : { parent: 100, executable: "/bin/sh", startedAt: `shell-${pid}` };
    expect(workerHookOwner(client, read, 10)).toBe(workerHookOwner(client, read, 20));
  });
  it("does not confuse reused native process ids with the preceding harness", () => {
    expect(workerHookOwner("codex", () => ({ parent: 1, executable: "codex", startedAt: "new" }), 100))
      .not.toBe(workerHookOwner("codex", () => ({ parent: 1, executable: "codex", startedAt: "old" }), 100));
  });
  it("a malformed worker hook refuses safely without blocking the harness", async () => {
    vi.stubEnv("LCM_SUMMARIZE_WORKER", "1");
    try { await expect(dispatchHook("restore", "not JSON")).resolves.toEqual({ exitCode: 0, stdout: "" }); }
    finally { vi.unstubAllEnvs(); }
  });
  it("refuses an owner it cannot verify", () => {
    expect(() => workerHookOwner("claude", () => ({ parent: 0, executable: "node", startedAt: "start" }), 100))
      .toThrow("unverified");
  });
});
