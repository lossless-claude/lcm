import { afterEach, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeHold } from "../../src/daemon/hold.js";

const execute = promisify(execFile);
const cli = resolve("dist/bin/lcm.js");
let root: string, dbPath: string, input: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-offline-hold-"));
  env = { ...process.env, HOME: root, LCM_HOME: root };
  const id = createHash("sha256").update(realpathSync(root)).digest("hex");
  const project = join(root, "projects", id);
  mkdirSync(project, { recursive: true });
  dbPath = join(project, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sentinel (value TEXT)"); db.close();
  writeFileSync(join(project, "meta.json"), JSON.stringify({ cwd: root }));
  input = join(root, "knowledge.json");
  writeFileSync(input, JSON.stringify({ version: 1, entries: [
    { content: "Keep database operations inside the admission boundary.", tags: ["decision"], confidence: 1, sessionId: null },
  ] }));
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port: 1 } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const commands = [["import-knowledge", "INPUT"], ["export"], ["bench", "build"], ["bench", "run"]];
it.each(commands)("held offline command %j refuses admission without changing SQLite", async (...args) => {
  writeHold(join(root, "daemon.pid"));
  const before = readFileSync(dbPath);
  await expect(execute(process.execPath, [cli, ...args.map((arg) => arg === "INPUT" ? input : arg)], {
    cwd: root, env, timeout: 10000,
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("held down until") });
  expect(readFileSync(dbPath)).toEqual(before);
  expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
});

it.each(commands)("held offline command %j still provides help", async (...args) => {
  writeHold(join(root, "daemon.pid"));
  const result = await execute(process.execPath, [cli, ...args.map((arg) => arg === "INPUT" ? input : arg), "--help"], { cwd: root, env, timeout: 10000 });
  expect(result.stdout).toMatch(/Usage:|lcm .*—/);
  expect(result.stderr).toBe("");
  expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
});

it("held stop drains an admitted offline import without requiring a daemon", async () => {
  const preload = join(root, "pause-input.mjs");
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.env.LCM_HOME;
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...options) {
      if (String(path) === root + '/knowledge.json') {
        fs.writeFileSync(root + '/ready', '');
        while (!fs.existsSync(root + '/resume')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return original.call(this, path, ...options);
    };
    syncBuiltinESMExports();
  `);
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("offline import barrier timed out");
      await delay(10);
    }
  }
  const importing = execute(process.execPath, ["--import", preload, cli, "import-knowledge", input], { cwd: root, env, timeout: 15000 });
  void importing.catch(() => {});
  let stop: ReturnType<typeof execute> | undefined;
  try {
    await waitFor(() => existsSync(join(root, "ready")));
    stop = execute(process.execPath, [cli, "daemon", "stop", "--hold"], { env, timeout: 10000 });
    let stopped = false;
    void stop.then(() => { stopped = true; }, () => { stopped = true; });
    await waitFor(() => existsSync(join(root, "daemon.hold")));
    await delay(100);
    expect(stopped).toBe(false);
    writeFileSync(join(root, "resume"), "");
    const result = await importing;
    expect(result.stdout).toContain("Imported 1 entries");
    await stop;
    const inspected = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(inspected.prepare("SELECT COUNT(*) AS count FROM promoted").get()).toMatchObject({ count: 1 }); }
    finally { inspected.close(); }
    expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
  } finally {
    writeFileSync(join(root, "resume"), ""); importing.child.kill();
    await Promise.allSettled([importing, ...(stop ? [stop] : [])]);
  }
}, 20000);
