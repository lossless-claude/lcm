import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDaemonLog, readDaemonLog, type DaemonLogOptions } from "../../src/daemon/log.js";
import { checkDaemonLog } from "../../src/doctor/daemon-log-check.js";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

const SECRET = "sk-ant-api03-" + "a".repeat(40);
const EPOCH = new Date(0);
const TWO_HUNDRED_BYTES_IN_MB = 200 / (1024 * 1024);
const FINISH_FLUSH_MS = 50;

describe("daemon log", () => {
  let home: string;
  let daemon: DaemonInstance | undefined;
  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = undefined; }
    rmSync(home, { recursive: true, force: true });
  });

  function options(overrides: Partial<DaemonLogOptions> = {}): DaemonLogOptions {
    home = mkdtempSync(join(tmpdir(), "lcm-log-"));
    return {
      path: join(home, "logs", "daemon.log"),
      level: "info",
      maxSizeMB: 10,
      retentionDays: 7,
      globalPatterns: [],
      projectDirFor: (cwd) => join(home, "projects", cwd.replace(/\W/g, "_")),
      version: "0.0.0-test",
      ...overrides,
    };
  }

  it("round-trips records at or above the configured level", () => {
    const opts = options();
    const log = openDaemonLog(opts);
    log.write("debug", "noise");
    log.write("warn", "compact.skipped", { session_id: "s1", reason: "no_work", candidates: 3 });
    const records = readDaemonLog(opts.path, { since: EPOCH });
    expect(records.map((r) => r.event)).toEqual(["compact.skipped"]);
    expect(records[0]).toMatchObject({ level: "warn", session_id: "s1", reason: "no_work", candidates: 3 });
    expect(readDaemonLog(opts.path, { since: EPOCH, minLevel: "error" })).toEqual([]);
  });

  it("marks each start with how the previous daemon ended", () => {
    const opts = options();
    const first = openDaemonLog(opts);
    first.start();
    first.close("SIGTERM");
    const second = openDaemonLog(opts);
    second.start();
    // no close: the next start must see an unclean predecessor
    openDaemonLog(opts).start();
    const starts = readDaemonLog(opts.path, { since: EPOCH }).filter((r) => r.event === "daemon.start");
    expect(starts.map((r) => r.prev)).toEqual(["none", "clean", "unclean"]);
  });

  it("writes no stop marker for a process that never started serving", () => {
    const opts = options();
    openDaemonLog(opts).close("hold");
    expect(existsSync(opts.path)).toBe(false);
  });

  it("scrubs free-form text of a record without a cwd", () => {
    const opts = options();
    openDaemonLog(opts).write("error", "route.failed", { route: "POST /x", err: new Error(`bad key ${SECRET}`) });
    const [record] = readDaemonLog(opts.path, { since: EPOCH });
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(record.err).toMatchObject({ name: "Error" });
    expect(String((record.err as { message: string }).message)).toContain("[REDACTED]");
  });

  it("scrubs identity fields and an error name that is not an identifier", () => {
    const opts = options();
    const err = new Error("boom");
    err.name = `Leaky ${SECRET}`;
    openDaemonLog(opts).write("error", "route.failed", { route: `POST /x?t=${SECRET}`, session_id: SECRET, err });
    const [record] = readDaemonLog(opts.path, { since: EPOCH });
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(record.session_id).toContain("[REDACTED]");
  });

  it("scrubs an identifier-shaped error name and code", () => {
    const opts = options();
    const awsKey = "AKIA" + "Z".repeat(16);
    const err = Object.assign(new Error("boom"), { code: awsKey });
    err.name = awsKey;
    openDaemonLog(opts).write("error", "route.failed", { err });
    expect(JSON.stringify(readDaemonLog(opts.path, { since: EPOCH }))).not.toContain(awsKey);
  });

  it("falls back to info for a malformed level", () => {
    const opts = options({ level: "toString" });
    const log = openDaemonLog(opts);
    log.write("debug", "noise");
    log.write("info", "kept");
    expect(readDaemonLog(opts.path, { since: EPOCH }).map((r) => r.event)).toEqual(["kept"]);
  });

  it("omits free-form text until the project's own patterns are loaded", async () => {
    const opts = options();
    const cwd = "/work/repo";
    mkdirSync(opts.projectDirFor(cwd), { recursive: true });
    writeFileSync(join(opts.projectDirFor(cwd), "sensitive-patterns.txt"), "project-only-\\d+\n");
    const log = openDaemonLog(opts);
    log.write("error", "compact.failed", { cwd, err: new Error("leaked project-only-42") });
    await log.prepare(cwd);
    log.write("error", "compact.failed", { cwd, err: new Error("leaked project-only-42") });
    const [pending, ready] = readDaemonLog(opts.path, { since: EPOCH });
    expect(pending).toMatchObject({ cwd, scrub: "pending" });
    expect((pending.err as { message?: string }).message).toBeUndefined();
    expect(ready.scrub).toBeUndefined();
    expect(JSON.stringify(ready)).not.toContain("project-only-42");
  });

  it("keeps both ends of a summarizer fallback while the project's patterns load", () => {
    const opts = options();
    const cwd = "/work/repo";
    mkdirSync(opts.projectDirFor(cwd), { recursive: true });
    writeFileSync(join(opts.projectDirFor(cwd), "sensitive-patterns.txt"), "project-only-\\d+\n");
    openDaemonLog(opts).write("warn", "summarizer.fallback", { cwd, from_provider: "deepseek", to_provider: "openrouter" });
    expect(readDaemonLog(opts.path, { since: EPOCH })[0]).toMatchObject({ from_provider: "deepseek", to_provider: "openrouter" });
  });

  it("rotates past the size limit and prunes rotations past retention", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const opts = options({ maxSizeMB: TWO_HUNDRED_BYTES_IN_MB, now: () => now });
    const log = openDaemonLog(opts);
    for (let i = 0; i < 5; i++) log.write("info", "request", { route: "POST /compact", status: 200 });
    const rotated = () => readdirSync(join(home, "logs")).filter((f) => f.startsWith("daemon.log."));
    expect(rotated().length).toBeGreaterThan(0);
    const old = join(home, "logs", rotated()[0]);
    utimesSync(old, new Date("2025-01-01"), new Date("2025-01-01"));
    now = new Date("2026-01-02T00:00:00Z");
    for (let i = 0; i < 5; i++) log.write("info", "request", { route: "POST /compact", status: 200 });
    expect(existsSync(old)).toBe(false);
  });

  it("never throws on a failed write, and records the gap once writing resumes", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const opts = options({ now: () => now });
    mkdirSync(join(home, "logs"), { recursive: true });
    mkdirSync(opts.path); // a directory where the file should be: every append fails
    const log = openDaemonLog(opts);
    expect(() => log.write("error", "compact.failed", { session_id: "s1" })).not.toThrow();
    log.write("error", "compact.failed", { session_id: "s2" });
    expect(log.state()).toMatchObject({ failing: true, dropped: 2 });
    rmSync(opts.path, { recursive: true });
    now = new Date("2026-01-01T00:02:00Z"); // past the one-minute pause
    log.write("info", "compact.done", { session_id: "s3" });
    const events = readDaemonLog(opts.path, { since: EPOCH }).map((r) => r.event);
    expect(events).toEqual(["log.gap", "compact.done"]);
    expect(log.state().failing).toBe(false);
  });

  it("counts a record it cannot render instead of throwing", () => {
    const opts = options();
    const log = openDaemonLog(opts);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => log.write("info", "x", { loop })).not.toThrow();
    expect(log.state()).toMatchObject({ failing: true, dropped: 1 });
  });

  it("keeps every rotation when two happen within one millisecond", () => {
    const opts = options({ maxSizeMB: TWO_HUNDRED_BYTES_IN_MB, now: () => EPOCH });
    const log = openDaemonLog(opts);
    for (let i = 0; i < 6; i++) log.write("info", "request", { route: "POST /compact", status: 200 });
    const records = readDaemonLog(opts.path, { since: EPOCH });
    expect(records).toHaveLength(6);
  });

  describe("doctor check", () => {
    it("reports errors only when the log proves continuity", () => {
      const opts = options();
      const log = openDaemonLog(opts);
      log.start();
      expect(checkDaemonLog(home, log.state())).toMatchObject({ status: "pass", message: "0 daemon errors (24h)" });
      log.write("error", "compact.failed", { session_id: "s1" });
      expect(checkDaemonLog(home, log.state())).toMatchObject({ status: "warn" });
      expect(checkDaemonLog(home, log.state()).message).toContain("1 daemon error (24h) — last: compact.failed");
    });

    it("warns when no daemon answers and the log does not end on a stop", () => {
      const opts = options();
      openDaemonLog(opts).start();
      expect(checkDaemonLog(home, undefined).message).toMatch(/^coverage incomplete: the last daemon is not running/);
    });

    it("judges a dead daemon by the log's last record, however old", () => {
      const opts = options({ now: () => new Date("2020-01-01T00:00:00Z") });
      openDaemonLog(opts).start();
      expect(checkDaemonLog(home, undefined).message).toMatch(/^coverage incomplete: the last daemon is not running/);
    });

    it("treats an unreadable log as unproven when no daemon answers", () => {
      const opts = options();
      mkdirSync(join(home, "logs"), { recursive: true });
      writeFileSync(opts.path, "");
      expect(checkDaemonLog(home, undefined).message).toMatch(/^coverage incomplete: the last daemon is not running/);
    });

    it("treats a missing log as unproven when no daemon answers", () => {
      options();
      expect(checkDaemonLog(home, undefined).message).toMatch(/^coverage incomplete: the last daemon is not running/);
      expect(checkDaemonLog(home, { failing: false, dropped: 0 }).message).toMatch(/^no daemon log yet/);
    });

    it("does not report a daemon that predates the log as clean", () => {
      options();
      expect(checkDaemonLog(home, "unsupported")).toMatchObject({ status: "warn" });
      expect(checkDaemonLog(home, "unsupported").message).toMatch(/predates the daemon log/);
    });

    it("warns that coverage is incomplete after an unclean predecessor", () => {
      const opts = options();
      openDaemonLog(opts).start();
      const next = openDaemonLog(opts);
      next.start();
      expect(checkDaemonLog(home, next.state()).message).toMatch(/^coverage incomplete: a daemon ended without a stop record/);
    });
  });

  it("logs every request and the cause of a failing route", async () => {
    const opts = options();
    const log = openDaemonLog(opts);
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }), { log });
    daemon.registerRoute("POST", "/boom", async () => { throw new Error("exploded"); });
    await fetch(`http://127.0.0.1:${daemon.address().port}/boom`, {
      method: "POST", body: JSON.stringify({ session_id: "s9", cwd: "/work/other", prompt: "never logged" }),
    });
    await new Promise((r) => setTimeout(r, FINISH_FLUSH_MS)); // the request line is written on "finish"
    const records = readDaemonLog(opts.path, { since: EPOCH });
    expect(records.find((r) => r.event === "route.failed")).toMatchObject({ route: "POST /boom", session_id: "s9", err: { message: "exploded" } });
    expect(records.find((r) => r.event === "request")).toMatchObject({ route: "POST /boom", status: 500, level: "error", cwd: "/work/other" });
    expect(JSON.stringify(records)).not.toContain("never logged");
  });

  it("logs a request the daemon refuses before any route runs", async () => {
    const opts = options();
    const tokenPath = join(home, "daemon.token");
    writeFileSync(tokenPath, "secret-token");
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }), { log: openDaemonLog(opts), tokenPath });
    await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, FINISH_FLUSH_MS));
    expect(readDaemonLog(opts.path, { since: EPOCH })).toContainEqual(
      expect.objectContaining({ event: "request", route: "POST /compact", status: 401, level: "warn" }));
  });
});
