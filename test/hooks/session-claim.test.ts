// test/hooks/session-claim.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { claimPath, functionHooksActive, functionHooksOwnSession } from "../../src/hooks/session-claim.js";

const GATE_ON = { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" } as NodeJS.ProcessEnv;
const written: string[] = [];

function claim(sessionId: string, body: unknown = { sessionId, ts: Date.now() }): void {
  const path = claimPath(sessionId);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  written.push(path);
}

afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true });
});

describe("functionHooksActive", () => {
  it("reads the gate variable only", () => {
    expect(functionHooksActive(GATE_ON)).toBe(true);
    expect(functionHooksActive({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("functionHooksOwnSession", () => {
  it("is true when the gate is open and the module claimed this session", () => {
    claim("sess-owned");
    expect(functionHooksOwnSession("sess-owned", GATE_ON)).toBe(true);
  });

  it("is false when the gate is open but no claim was written", () => {
    expect(functionHooksOwnSession("sess-never-claimed", GATE_ON)).toBe(false);
  });

  it("is false when a claim exists but the gate is closed", () => {
    claim("sess-gate-off");
    expect(functionHooksOwnSession("sess-gate-off", {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is false when the claim names a different session", () => {
    const path = claimPath("sess-mismatch");
    writeFileSync(path, JSON.stringify({ sessionId: "someone-else", ts: Date.now() }));
    written.push(path);
    expect(functionHooksOwnSession("sess-mismatch", GATE_ON)).toBe(false);
  });

  it("is false on an unreadable claim, so the command hook keeps recording", () => {
    claim("sess-corrupt", "{ not json");
    expect(functionHooksOwnSession("sess-corrupt", GATE_ON)).toBe(false);
  });

  it("is false without a session id", () => {
    expect(functionHooksOwnSession(undefined, GATE_ON)).toBe(false);
    expect(functionHooksOwnSession("", GATE_ON)).toBe(false);
  });

  it("keeps a session id with path separators inside the temp dir", () => {
    expect(claimPath("../../etc/passwd").startsWith(tmpdir())).toBe(true);
    expect(claimPath("../../etc/passwd")).not.toContain("/etc/");
  });
});
