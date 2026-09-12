/**
 * E2E Flow Tests: the self-contained plugin (Flow 21)
 *
 * A marketplace install is a copy of the tagged repository under
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, with no node_modules,
 * no npm cache and no `lcm` on PATH. plugin.json calls bundle/lcm.js directly, in
 * exec form. This test builds the bundle into such a directory, reads the
 * SessionStart hook out of the manifest exactly as Claude Code would, and runs it.
 *
 * Isolation: the child gets a throwaway HOME whose config.json points at the
 * harness daemon, an empty npm cache, and a PATH with nothing on it but the
 * interpreter Claude Code would resolve `node` to.
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "../harness.js";
// @ts-expect-error — a plain ESM script without declarations; vitest resolves it.
import { buildBundle } from "../../../scripts/build-bundle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

type CommandHook = { type: string; command: string; args?: string[]; timeout?: number };

let handle: HarnessHandle | null = null;
let fakeHome = "";
let pluginRoot = "";

beforeAll(async () => {
  handle = await createHarness("mock");
  fakeHome = mkdtempSync(join(tmpdir(), "lcm-plugin-home-"));
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;
  pluginRoot = join(fakeHome, ".claude", "plugins", "cache", "lossless-claude", "lcm", version);
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), join(pluginRoot, ".claude-plugin", "plugin.json"));
  await buildBundle({ outDir: join(pluginRoot, "bundle"), buildId: "0123456789abcdef" });

  mkdirSync(join(fakeHome, ".lossless-claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".lossless-claude", "config.json"), JSON.stringify({ daemon: { port: handle.daemonPort } }));
  mkdirSync(join(fakeHome, "npm-cache"), { recursive: true });
}, 120_000);

afterAll(async () => {
  try {
    if (handle) {
      await handle.cleanup();
      handle = null;
    }
  } finally {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith("lcm-restore-e2e-plugin-")) rmSync(join(tmpdir(), f), { force: true });
    }
  }
});

function manifestHook(event: string): CommandHook {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  return manifest.hooks[event][0].hooks[0] as CommandHook;
}

/** Exactly what Claude Code does with an exec-form hook: substitute the placeholder, spawn without a shell. */
function runHook(hook: CommandHook, stdin: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  expect(hook.args, "plugin hooks must be exec form: command + args, no shell").toBeDefined();
  const substitute = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  const command = substitute(hook.command);
  const args = hook.args!.map(substitute);
  return new Promise((resolve, reject) => {
    const child = spawn(command === "node" ? process.execPath : command, args, {
      env: {
        PATH: dirname(process.execPath),
        HOME: fakeHome,
        LCM_HOME: join(fakeHome, ".lossless-claude"),
        npm_config_cache: join(fakeHome, "npm-cache"),
        TMPDIR: tmpdir(),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`hook timed out\n${stderr}`)); }, 30_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

describe("Flow 21: the installed plugin runs from bundle/ with no npm cache", { timeout: 120_000 }, () => {
  it("has nothing to install: no node_modules, no npm cache, no lcm on PATH", () => {
    expect(existsSync(join(pluginRoot, "node_modules"))).toBe(false);
    expect(readdirSync(join(fakeHome, "npm-cache"))).toEqual([]);
    expect(existsSync(join(pluginRoot, "bundle", "lcm.js"))).toBe(true);
    expect(existsSync(join(pluginRoot, "bundle", "mcp-server.js"))).toBe(true);
    expect(existsSync(join(pluginRoot, "bundle", "assets", "prompts", "system.yaml"))).toBe(true);
    expect(existsSync(join(pluginRoot, "bundle", "assets", "templates", "base.md"))).toBe(true);
  });

  it("runs the SessionStart hook from plugin.json and exits 0", async () => {
    const h = handle!;
    const r = await runHook(
      manifestHook("SessionStart"),
      JSON.stringify({ session_id: `e2e-plugin-${Math.random().toString(36).slice(2)}`, cwd: h.tmpDir, source: "startup" }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Cannot find (module|package)/);
    expect(readdirSync(join(fakeHome, "npm-cache"))).toEqual([]);
    expect(existsSync(join(pluginRoot, "node_modules"))).toBe(false);
  });

  it("registers the MCP server in exec form, pointing at the bundle", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.mcpServers.lcm).toEqual({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bundle/mcp-server.js"] });
    for (const groups of Object.values(manifest.hooks) as { hooks: CommandHook[] }[][]) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toBe("node");
          expect(hook.args?.[0]).toBe("${CLAUDE_PLUGIN_ROOT}/bundle/lcm.js");
        }
      }
    }
  });
});
