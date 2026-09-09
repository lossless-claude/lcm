import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { holdPath, readHold, writeHold } from "../../src/daemon/hold.js";

const intercept = vi.hoisted(() => ({ writing: undefined as undefined | ((path: string) => void), reading: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    writeFileSync: (path: string, data: string, options?: any) => {
      if (intercept.writing) {
        const callback = intercept.writing; intercept.writing = undefined;
        actual.writeFileSync(path, "", options); callback(path);
        options = { ...options, flag: "w" };
      }
      return actual.writeFileSync(path, data, options);
    },
    readFileSync: (...args: any[]) => {
      const result = (actual.readFileSync as any)(...args);
      const callback = intercept.reading; intercept.reading = undefined; callback?.();
      return result;
    },
  };
});
let dir: string;
let pid: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), "hold-race-")); pid = join(dir, "daemon.pid"); });
afterEach(() => { intercept.writing = undefined; intercept.reading = undefined; fs.rmSync(dir, { recursive: true, force: true }); });
describe("hold publication interleavings", () => {
  it("keeps the previous complete marker visible while the next marker is written", () => {
    const old = writeHold(pid, { reason: "old" });
    intercept.writing = () => { expect(readHold(pid)).toEqual(old); };
    const next = writeHold(pid, { reason: "next" });
    expect(readHold(pid)).toEqual(next);
    expect(fs.readdirSync(dir)).toEqual(["daemon.hold"]);
  });
  it("cleans an unpublished temporary file when writing fails", () => {
    const old = writeHold(pid);
    intercept.writing = () => { throw new Error("disk full"); };
    expect(() => writeHold(pid)).toThrow("disk full");
    expect(readHold(pid)).toEqual(old);
    expect(fs.readdirSync(dir)).toEqual(["daemon.hold"]);
  });
  it.each(["expired", "invalid"])("a %s snapshot reader cannot remove a newly published hold", (kind) => {
    if (kind === "expired") writeHold(pid, { now: new Date(0) });
    else fs.writeFileSync(holdPath(pid), "invalid");
    intercept.reading = () => { writeHold(pid, { reason: "new" }); };
    expect(readHold(pid)).toBeNull();
    expect(readHold(pid)?.reason).toBe("new");
  });
});
