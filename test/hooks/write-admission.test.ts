import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clearHold, writeHold } from "../../src/daemon/hold.js";
import { recordPostToolEvents } from "../../src/hooks/post-tool.js";
import { recordUserPromptEvents } from "../../src/hooks/user-prompt.js";
import { safeLogError, _resetCircuitBreaker } from "../../src/hooks/hook-errors.js";

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.LCM_HOME!, "events", "test.db"),
}));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-hook-admission-"));
  vi.stubEnv("LCM_HOME", root);
  vi.stubEnv("LCM_LOG_PATH", join(root, "events.log"));
  _resetCircuitBreaker();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const payload = { session_id: "test", cwd: "/project", tool_name: "AskUserQuestion",
  tool_input: { question: "Use SQLite?" }, tool_response: "yes" };

it("blocks every direct hook sidecar writer and error-log fallback while held", async () => {
  writeHold(join(root, "daemon.pid"));
  expect(recordPostToolEvents(payload).recorded).toBe(0);
  expect(await recordUserPromptEvents("Always use TypeScript", "test", "/project")).toBe(0);
  safeLogError("PostToolUse", new Error("held"), { cwd: "/project" });
  safeLogError("PostToolUse", new Error("held fallback"), {});
  expect(readdirSync(root)).toEqual(["daemon.hold"]);
  clearHold(join(root, "daemon.pid"));
  expect(recordPostToolEvents(payload).recorded).toBeGreaterThan(0);
  expect(await recordUserPromptEvents("Always use TypeScript", "test", "/project")).toBeGreaterThan(0);
  safeLogError("PostToolUse", new Error("resumed fallback"), {});
  expect(existsSync(join(root, "events.log"))).toBe(true);
  expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
});

it("held stop drains a command-hook write already inside SQLite before succeeding", async () => {
  const execute = promisify(execFile);
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("hook barrier timed out");
      await delay(10);
    }
  }
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port: 1 } }));
  const script = join(root, "writer.mjs");
  const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(resolve("dist/src/hooks", file)).href);
  writeFileSync(script, `
    import fs from 'node:fs';
    import { EventsDb } from ${moduleUrl("events-db.js")};
    import { recordPostToolEvents } from ${moduleUrl("post-tool.js")};
    const root = process.env.LCM_HOME;
    const insert = EventsDb.prototype.insertToolCallEvents;
    EventsDb.prototype.insertToolCallEvents = function(...args) {
      fs.writeFileSync(root + '/ready', '');
      while (!fs.existsSync(root + '/resume')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return insert.apply(this, args);
    };
    console.log(recordPostToolEvents(${JSON.stringify(payload)}).recorded);
  `);
  const env = { ...process.env, HOME: root, LCM_HOME: root };
  const writer = execute(process.execPath, [script], { env, timeout: 15000 });
  const writerDone = writer.then((result) => result, (error) => { throw error; });
  void writerDone.catch(() => {});
  let stop: ReturnType<typeof execute> | undefined;
  try {
    await waitFor(() => existsSync(join(root, "ready")));
    stop = execute(process.execPath, [resolve("dist/bin/lcm.js"), "daemon", "stop", "--hold"], { env, timeout: 10000 });
    let stopped = false;
    void stop.then(() => { stopped = true; }, () => { stopped = true; });
    await waitFor(() => existsSync(join(root, "daemon.hold")));
    await delay(100);
    expect(stopped).toBe(false);
    writeFileSync(join(root, "resume"), "");
    expect(Number((await writerDone).stdout.trim())).toBeGreaterThan(0);
    await expect(stop).resolves.toMatchObject({ stderr: "" });
    expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
  } finally {
    writeFileSync(join(root, "resume"), "");
    writer.child.kill();
    await Promise.allSettled([writerDone, ...(stop ? [stop] : [])]);
  }
}, 20000);
