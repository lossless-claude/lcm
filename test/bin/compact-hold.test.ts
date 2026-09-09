import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeHold } from "../../src/daemon/hold.js";

const execute = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("compact barrier timed out");
    await delay(10);
  }
}

it("held compact refuses admission without migrating project databases", async () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-compact-held-"));
  const project = join(root, "projects", "legacy");
  mkdirSync(project, { recursive: true });
  const dbPath = join(project, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sentinel (value TEXT)"); db.close();
  writeFileSync(join(project, "meta.json"), JSON.stringify({ cwd: root }));
  writeHold(join(root, "daemon.pid"));
  const before = readFileSync(dbPath);
  try {
    await expect(execute(process.execPath, [resolve("dist/bin/lcm.js"), "compact", "--all"], {
      cwd: root, env: { ...process.env, HOME: root, LCM_HOME: root }, timeout: 10000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("held down until") });
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("held stop waits for admitted compact local migrations until the CLI exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-compact-drain-"));
  const project = join(root, "projects", "legacy");
  mkdirSync(project, { recursive: true });
  const dbPath = join(project, "db.sqlite");
  new DatabaseSync(dbPath).close();
  writeFileSync(join(project, "meta.json"), JSON.stringify({ cwd: root }));
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok" })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port } }));
  const preload = join(root, "pause-sqlite.mjs");
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.env.LCM_HOME;
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...options) {
      if (String(path).endsWith('/projects/legacy/meta.json')) {
        fs.writeFileSync(root + '/ready', '');
        while (!fs.existsSync(root + '/resume')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return original.call(this, path, ...options);
    };
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, HOME: root, LCM_HOME: root };
  const cli = resolve("dist/bin/lcm.js");
  const compact = execute(process.execPath, ["--import", preload, cli, "compact", "--all", "--no-promote"], { cwd: root, env, timeout: 15000 });
  void compact.catch(() => {});
  let stop: ReturnType<typeof execute> | undefined;
  try {
    await Promise.race([
      waitFor(() => existsSync(join(root, "ready"))),
      compact.then((result) => { throw new Error(`compact exited before SQLite: ${result.stdout} ${result.stderr}`); }),
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stop = execute(process.execPath, [cli, "daemon", "stop", "--hold"], { env, timeout: 10000 });
    let stopped = false;
    void stop.then(() => { stopped = true; }, () => { stopped = true; });
    await waitFor(() => existsSync(join(root, "daemon.hold")));
    await delay(100);
    expect(stopped).toBe(false);
    writeFileSync(join(root, "resume"), "");
    await compact;
    await stop;
    expect(readdirSync(root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
    const inspected = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'conversations'").get()).toBeDefined(); }
    finally { inspected.close(); }
  } finally {
    server.close();
    writeFileSync(join(root, "resume"), ""); compact.child.kill();
    await Promise.allSettled([compact, ...(stop ? [stop] : [])]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
