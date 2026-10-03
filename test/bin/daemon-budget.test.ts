import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

it("ordinary CLI clients connect to a busy daemon within their ten-second lifecycle budget", async () => {
  let healthCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const timer = setTimeout(() => res.end(JSON.stringify({ status: "ok" })), ++healthCalls === 1 ? 6_000 : 0);
      res.once("close", () => clearTimeout(timer));
    } else {
      res.end(JSON.stringify({ daemon: { status: "up" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(createLcmPaths(lcmHome()).configPath, JSON.stringify({ daemon: { port } }));
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../../dist/bin/lcm.js", import.meta.url)), "status", "--json"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 12_000,
      });
    expect(JSON.parse(stdout)).toEqual({ daemon: { status: "up" } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
