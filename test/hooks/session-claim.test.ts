// test/hooks/session-claim.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { claimPath, functionHooksOwnSession } from "../../src/hooks/session-claim.js";

const written: string[] = [];
const MINUTE = 60_000;

function claim(sessionId: string, body: unknown = { sessionId, ts: Date.now() }): void {
  const path = claimPath(sessionId);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  written.push(path);
}

afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true });
  delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
});

describe("functionHooksOwnSession", () => {
  it("is true for a fresh claim naming this session, with no gate variable set", () => {
    claim("sess-owned");
    expect(functionHooksOwnSession("sess-owned")).toBe(true);
  });

  it("is false when no claim was written", () => {
    expect(functionHooksOwnSession("sess-never-claimed")).toBe(false);
  });

  // A crash skips session.end, so the claim it leaves behind must lapse on its own.
  it("is false for a stale claim, even with the gate variable set", () => {
    process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1";
    claim("sess-stale", { sessionId: "sess-stale", ts: Date.now() - 10 * MINUTE });
    expect(functionHooksOwnSession("sess-stale")).toBe(false);
  });

  it("is false for a claim withdrawn at session.end, even with the gate variable set", () => {
    process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1";
    claim("sess-ended", { sessionId: "sess-ended", ts: Date.now(), ended: "clear" });
    expect(functionHooksOwnSession("sess-ended")).toBe(false);
  });

  it("is false for a claim without a usable timestamp", () => {
    claim("sess-no-ts", { sessionId: "sess-no-ts" });
    expect(functionHooksOwnSession("sess-no-ts")).toBe(false);
  });

  it("is false when the claim names a different session", () => {
    const path = claimPath("sess-mismatch");
    writeFileSync(path, JSON.stringify({ sessionId: "someone-else", ts: Date.now() }));
    written.push(path);
    expect(functionHooksOwnSession("sess-mismatch")).toBe(false);
  });

  it("is false on an unreadable claim, so the command hook keeps recording", () => {
    claim("sess-corrupt", "{ not json");
    expect(functionHooksOwnSession("sess-corrupt")).toBe(false);
  });

  it("is false without a session id", () => {
    expect(functionHooksOwnSession(undefined)).toBe(false);
    expect(functionHooksOwnSession("")).toBe(false);
  });

  it("keeps a session id with path separators inside the temp dir", () => {
    expect(claimPath("../../etc/passwd").startsWith(tmpdir())).toBe(true);
    expect(claimPath("../../etc/passwd")).not.toContain("/etc/");
  });

  it("keeps sessions with colliding sanitized IDs separate", () => {
    expect(claimPath("a/b")).not.toBe(claimPath("a_b"));
  });
});
