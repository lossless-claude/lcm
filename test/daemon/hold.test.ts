import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOLD_MINUTES, clearHold, holdPath, readHold, writeHold } from "../../src/daemon/hold.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

let dir: string;
let pidFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcm-hold-"));
  pidFilePath = join(dir, "daemon.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hold marker", () => {
  it("reports no hold when none was placed", () => {
    expect(readHold(pidFilePath)).toBeNull();
  });

  it("reads back a hold it wrote", () => {
    const written = writeHold(pidFilePath, { reason: "retag" });
    const read = readHold(pidFilePath);
    expect(read?.reason).toBe("retag");
    expect(read?.until).toBe(written.until);
    expect(read?.pid).toBe(process.pid);
  });

  it("defaults the expiry to DEFAULT_HOLD_MINUTES", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const hold = writeHold(pidFilePath, { now });
    expect(hold.until).toBe(new Date(now.getTime() + DEFAULT_HOLD_MINUTES * 60_000).toISOString());
  });

  it("treats an expired hold as no hold, and removes it", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    writeHold(pidFilePath, { minutes: 10, now });
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(readHold(pidFilePath, later)).toBeNull();
    expect(existsSync(holdPath(pidFilePath))).toBe(false);
  });

  it("treats a corrupt marker as no hold, and removes it", () => {
    writeFileSync(holdPath(pidFilePath), "not json");
    expect(readHold(pidFilePath)).toBeNull();
    expect(existsSync(holdPath(pidFilePath))).toBe(false);
  });

  it.each([
    null, [], "hold", 42,
    { until: "2099-01-01T00:00:00.000Z" },
    { pid: "42", until: "2099-01-01T00:00:00.000Z" },
    { pid: 0, until: "2099-01-01T00:00:00.000Z" },
    { pid: 1.5, until: "2099-01-01T00:00:00.000Z" },
    { pid: 42, until: 4102444800000 },
    { pid: 42, until: "invalid" },
    { pid: 42, until: "2099-01-01T00:00:00.000Z", reason: {} },
  ])("removes a malformed marker: %j", (value) => {
    writeFileSync(holdPath(pidFilePath), JSON.stringify(value));
    expect(readHold(pidFilePath)).toBeNull();
    expect(existsSync(holdPath(pidFilePath))).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, Number.MAX_VALUE])(
    "rejects invalid duration %s without replacing an existing hold",
    (minutes) => {
      const existing = writeHold(pidFilePath, { reason: "maintenance" });
      expect(() => writeHold(pidFilePath, { minutes })).toThrow(/Hold minutes/);
      expect(readHold(pidFilePath)).toEqual(existing);
    },
  );

  it("clearHold reports whether a marker was there", () => {
    expect(clearHold(pidFilePath)).toBe(false);
    writeHold(pidFilePath, {});
    expect(clearHold(pidFilePath)).toBe(true);
    expect(readHold(pidFilePath)).toBeNull();
  });

  it("a later hold replaces an earlier one", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    writeHold(pidFilePath, { minutes: 5, reason: "first", now });
    writeHold(pidFilePath, { minutes: 60, reason: "second", now });
    const hold = readHold(pidFilePath, new Date(now.getTime() + 10 * 60_000));
    expect(hold?.reason).toBe("second");
  });
});

describe("ensureDaemon under a hold", () => {
  it("refuses to spawn, and never asks the daemon anything", async () => {
    writeHold(pidFilePath, { reason: "maintenance" });
    let fetched = 0;
    const result = await ensureDaemon({
      port: 39999,
      pidFilePath,
      spawnTimeoutMs: 100,
      _fetchOverride: (async () => { fetched++; throw new Error("unreachable"); }) as unknown as typeof globalThis.fetch,
      _spawnOverride: (() => { throw new Error("must not spawn under a hold"); }) as never,
    });
    expect(result).toEqual({ connected: false, port: 39999, spawned: false });
    expect(fetched).toBe(0);
  });

  it("resumes normally once the hold expires", async () => {
    const now = new Date();
    writeHold(pidFilePath, { minutes: 1, now: new Date(now.getTime() - 120_000) });
    let fetched = 0;
    const result = await ensureDaemon({
      port: 39999,
      pidFilePath,
      spawnTimeoutMs: 100,
      _skipSpawn: true,
      _fetchOverride: (async () => { fetched++; throw new Error("down"); }) as unknown as typeof globalThis.fetch,
    });
    expect(result.spawned).toBe(false);
    expect(fetched).toBeGreaterThan(0);
  });
});
