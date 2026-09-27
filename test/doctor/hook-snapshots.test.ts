import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFunctionHookSnapshots } from "../../src/doctor/hook-snapshots.js";

describe("function-hook snapshot inspection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the last valid slot when a newer whole-file write is incomplete", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-hook-snapshot-test-"));
    dirs.push(dir);
    const first = {
      version: 1, harness: "claude-function", sessionId: "s1", cwd: "/project", seq: 1,
      observations: [{ hook: "tool.call", operation: "tool-capture", kind: "delivery",
        status: "unconfirmed", reason: "", count: 3 }],
    };
    writeFileSync(join(dir, "lcm-hook-observe-s1-1.json"), JSON.stringify(first));
    writeFileSync(join(dir, "lcm-hook-observe-s1-0.json"), '{"version":1');

    expect(readFunctionHookSnapshots("/project", dir)).toMatchObject([
      { sessionId: "s1", observations: [{ status: "unconfirmed", count: 3 }] },
    ]);
    expect(readFunctionHookSnapshots("/other-project", dir)).toEqual([]);
  });

  it("prefers a new module generation even when its sequence restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-hook-snapshot-restart-"));
    dirs.push(dir);
    const older = join(dir, "lcm-hook-observe-s1-0.json");
    const newer = join(dir, "lcm-hook-observe-s1-1.json");
    const base = { version: 1, harness: "claude-function", sessionId: "s1", cwd: "/project", observations: [] };
    writeFileSync(older, JSON.stringify({ ...base, generation: 1, seq: 100 }));
    writeFileSync(newer, JSON.stringify({ ...base, generation: 2, seq: 1 }));
    const now = Date.now();
    utimesSync(older, (now - 1000) / 1000, (now - 1000) / 1000);
    utimesSync(newer, now / 1000, now / 1000);
    expect(readFunctionHookSnapshots("/project", dir)[0]).toMatchObject({ generation: 2, seq: 1 });
  });
});
