import { afterEach, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "../../hooks/lcm-hooks.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { clearHold, readHold, writeHold } from "../../src/daemon/hold.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

const execute = promisify(execFile);
let dir: string, home: string, root: string, pid: string, server: Server, requests: number;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hold-start-"));
  home = join(dir, "home"); root = join(dir, "storage");
  mkdirSync(home); mkdirSync(root);
  env = { ...process.env, HOME: home, LCM_HOME: root };
  pid = createLcmPaths(lcmHome(env)).pidPath;
  requests = 0;
  server = createServer((_req, res) => { requests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok", version: "test" })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port: (server.address() as any).port } }));
});
afterEach(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
const cli = (...args: string[]) => execute(process.execPath, [resolve("dist/bin/lcm.js"), "daemon", "start", ...args], { env, timeout: 10000 });

it("automatic built CLI preserves the LCM_HOME hold; explicit start releases it", async () => {
  const hold = writeHold(pid);
  await cli("--automatic", "--detach");
  expect(readHold(pid)).toEqual(hold);
  expect(requests).toBe(0);
  const result = await ensureDaemon({ port: (server.address() as any).port, pidFilePath: pid, spawnTimeoutMs: 100 });
  expect(result).toMatchObject({ connected: false, spawned: false });
  expect(requests).toBe(0);
  expect(clearHold(pid)).toBe(true);
  writeHold(pid);
  await cli();
  expect(readHold(pid)).toBeNull();
  expect(requests).toBe(1);
  expect(existsSync(join(home, ".lossless-claude"))).toBe(false);
});

it("a function-hook tool event cannot release a hold through its actual startup command", async () => {
  const held = writeHold(pid);
  const handlers = new Map<string, any>();
  register(((event: string, callback: any) => handlers.set(event, callback)) as any, {} as any);
  const commands: string[] = [];
  const engine = {
    session: { id: async () => "hold-test", cwd: async () => dir },
    ui: { log: () => {} },
    http: { fetch: async () => { throw new Error("offline"); } },
    process: { run: async (args: string[]) => {
      const command = args[2];
      if (command.includes("__CONFIG__")) return { stdout: `\n__CONFIG__\n{}\n__TMPDIR__\n${dir}`, stderr: "", exitCode: 0 };
      commands.push(command);
      const suffix = command.split("exec lcm daemon start ")[1].split(" ");
      const result = await cli(...suffix);
      return { ...result, exitCode: 0 };
    } },
  };
  await handlers.get("tool.call")(engine, { tool: "Read", tool_use_id: "one" }, async () => ({ result: "ok" }));
  expect(commands).toHaveLength(1);
  expect(readHold(pid)).toEqual(held);
  expect(requests).toBe(0);
  expect(existsSync(join(home, ".lossless-claude"))).toBe(false);
});
