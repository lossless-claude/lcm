import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `.claude-plugin/lcm-mcp.sh` is the static launcher plugin.json's mcpServers.lcm
// points at (#424). It must start the server under `env -i PATH=/usr/bin:/bin` —
// i.e. without relying on PATH resolving `node` — by reading the interpreter path
// lcm itself measured and recorded in config.json, falling back to PATH only when
// nothing was recorded yet.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcherSrc = join(repoRoot, ".claude-plugin", "lcm-mcp.sh");

let dir: string;
let pluginDir: string;
let launcher: string;
let fakeHome: string;

function writeStubNode(path: string, label: string): void {
  writeFileSync(path, `#!/bin/sh\necho "${label}: $@"\n`, "utf8");
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcm-mcp-launcher-"));
  pluginDir = join(dir, "plugin", ".claude-plugin");
  mkdirSync(pluginDir, { recursive: true });
  launcher = join(pluginDir, "lcm-mcp.sh");
  copyFileSync(launcherSrc, launcher);
  chmodSync(launcher, 0o755);
  writeFileSync(join(dir, "plugin", "mcp.mjs"), "// stub\n", "utf8");
  fakeHome = join(dir, "home");
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>): string {
  return execFileSync("env", ["-i", `PATH=${env.PATH ?? "/usr/bin:/bin"}`, ...Object.entries(env)
    .filter(([k]) => k !== "PATH")
    .map(([k, v]) => `${k}=${v}`), launcher], { encoding: "utf8" }).trim();
}

// This is exactly the "Done when" contract for #424: `env -i PATH=/usr/bin:/bin` —
// which has no `node` on macOS/most Linux — plus the coreutils (dirname/sed/grep)
// the launcher itself needs for its own logic.
const MINIMAL_PATH = "/usr/bin:/bin";

it("execs the node path recorded in config.json, ignoring PATH entirely", () => {
  const recordedNode = join(dir, "recorded-node");
  writeStubNode(recordedNode, "recorded");
  const defaultLcmHome = join(fakeHome, ".lossless-claude");
  mkdirSync(defaultLcmHome, { recursive: true });
  writeFileSync(join(defaultLcmHome, "config.json"), JSON.stringify({ mcpNodePath: recordedNode }, null, 2));

  // PATH has no node at all — proves the config path, not PATH, wins.
  const out = run({ PATH: MINIMAL_PATH, HOME: fakeHome });

  expect(out).toBe(`recorded: ${join(dir, "plugin", "mcp.mjs")}`);
});

it("honors LCM_HOME over HOME, mirroring src/lcm-home.ts", () => {
  const recordedNode = join(dir, "recorded-node");
  writeStubNode(recordedNode, "recorded");
  const lcmHome = join(dir, "custom-lcm-home");
  mkdirSync(lcmHome, { recursive: true });
  writeFileSync(join(lcmHome, "config.json"), JSON.stringify({ mcpNodePath: recordedNode }, null, 2));

  const out = run({ PATH: MINIMAL_PATH, HOME: fakeHome, LCM_HOME: lcmHome });

  expect(out).toBe(`recorded: ${join(dir, "plugin", "mcp.mjs")}`);
});

it("falls back to PATH when config.json has no recorded node path yet", () => {
  const pathBin = join(dir, "bin");
  mkdirSync(pathBin, { recursive: true });
  writeStubNode(join(pathBin, "node"), "from-path");
  // No config.json at all — first-ever run.

  const out = run({ PATH: `${pathBin}:${MINIMAL_PATH}`, HOME: fakeHome });

  expect(out).toBe(`from-path: ${join(dir, "plugin", "mcp.mjs")}`);
});

it("falls back to PATH when the recorded node path is stale (no longer executable)", () => {
  const pathBin = join(dir, "bin");
  mkdirSync(pathBin, { recursive: true });
  writeStubNode(join(pathBin, "node"), "from-path");
  const defaultLcmHome = join(fakeHome, ".lossless-claude");
  mkdirSync(defaultLcmHome, { recursive: true });
  writeFileSync(join(defaultLcmHome, "config.json"), JSON.stringify({ mcpNodePath: join(dir, "gone") }, null, 2));

  const out = run({ PATH: `${pathBin}:${MINIMAL_PATH}`, HOME: fakeHome });

  expect(out).toBe(`from-path: ${join(dir, "plugin", "mcp.mjs")}`);
});

it("exits non-zero with a clear message when no interpreter is found anywhere", () => {
  expect(() => run({ PATH: MINIMAL_PATH, HOME: fakeHome })).toThrowError(
    /Command failed/,
  );
  try {
    run({ PATH: MINIMAL_PATH, HOME: fakeHome });
  } catch (err: any) {
    expect(String(err.stderr)).toContain("no node interpreter found");
  }
});
