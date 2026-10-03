import { afterEach, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readHold, writeHold } from "../../src/daemon/hold.js";

const execute = promisify(execFile);
let root: string, preload: string, pidPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-restart-hold-"));
  pidPath = join(root, "daemon.pid");
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port: 1 } }));
  preload = join(root, "no-spawn.mjs");
  writeFileSync(preload, `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawn = () => { throw new Error('daemon spawn blocked by fixture'); };
    syncBuiltinESMExports();
  `);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const restart = (...args: string[]) => execute(process.execPath,
  ["--import", preload, resolve("dist/bin/lcm.js"), "daemon", "restart", ...args], {
    env: { ...process.env, HOME: root, LCM_HOME: root }, timeout: 10000,
  });

it("restart refuses an active hold, reports its owner, reason and expiry, and preserves it", async () => {
  const hold = writeHold(pidPath, { reason: "store maintenance" });
  const result = await restart().catch(error => error);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`held down until ${hold.until}`);
  expect(result.stderr).toContain(`pid ${hold.pid}: store maintenance`);
  expect(result.stdout).toBe("");
  expect(readHold(pidPath)).toEqual(hold);
});

it("restart releases a hold only when --release-hold is explicit", async () => {
  writeHold(pidPath, { reason: "store maintenance" });
  // Reaching the spawn boundary proves restart continued after releasing.
  await expect(restart("--release-hold")).rejects.toMatchObject({
    stderr: expect.stringContaining("daemon spawn blocked by fixture"),
    stdout: expect.stringContaining("released the daemon hold"),
  });
  expect(readHold(pidPath)).toBeNull();
});

it("daemon help documents restart's hold refusal and explicit release", async () => {
  const result = await execute(process.execPath, [resolve("dist/bin/lcm.js"), "help", "daemon"], {
    env: { ...process.env, HOME: root, LCM_HOME: root }, timeout: 10000,
  });
  expect(result.stdout).toContain("--release-hold");
  expect(result.stdout).toContain("restart preserves an active hold");
  expect(result.stdout).toContain("lcm daemon start");
  expect(result.stdout).toContain("lcm daemon restart --release-hold");
});
