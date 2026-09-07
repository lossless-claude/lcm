/**
 * E2E Flow Tests: Hook process path (Flow 20)
 *
 * Every other hook test imports the handler directly. This one runs the real
 * entry point Claude Code uses — `node lcm.mjs <cmd>` with JSON on stdin — so
 * readStdin, dispatchHook, bootstrap and auto-heal are exercised together.
 *
 * Isolation: the child gets a throwaway HOME whose config.json points at the
 * harness daemon, so nothing touches ~/.lossless-claude or ~/.claude.
 *
 * Requires a fresh `npm run build` — the wrapper runs dist/.
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "../harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const WRAPPER = join(REPO_ROOT, "lcm.mjs");
const DIST_CLI = join(REPO_ROOT, "dist", "bin", "lcm.js");

const HOOK_COMMANDS = [
  ["compact", "--hook"],
  ["restore"],
  ["session-end"],
  ["user-prompt"],
  ["post-tool"],
  ["session-snapshot"],
] as const;

let handle: HarnessHandle | null = null;
let fakeHome = "";

interface HookRun { status: number | null; stdout: string; stderr: string }

// Async on purpose: the harness daemon lives in this same process, so a
// blocking spawnSync would deadlock every hook that talks to it.
function runHook(args: readonly string[], stdin: string): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], {
      env: { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: undefined },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`hook ${args.join(" ")} timed out\n${stderr}`)); }, 30_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

function payload(extra: Record<string, unknown>): string {
  const h = handle!;
  return JSON.stringify({ session_id: `e2e-proc-${Math.random().toString(36).slice(2)}`, cwd: h.tmpDir, ...extra });
}

beforeAll(async () => {
  if (!existsSync(DIST_CLI)) {
    throw new Error(`dist/bin/lcm.js missing — run \`npm run build\` before the hook process tests`);
  }
  handle = await createHarness("mock");
  fakeHome = mkdtempSync(join(tmpdir(), "lcm-hook-home-"));
  mkdirSync(join(fakeHome, ".lossless-claude"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".lossless-claude", "config.json"),
    JSON.stringify({ daemon: { port: handle.daemonPort } }),
  );
}, 60_000);

afterAll(async () => {
  if (handle) {
    await handle.cleanup();
    handle = null;
  }
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
  // restore leaves a per-session lock file in tmpdir
  for (const f of readdirSync(tmpdir())) {
    if (f.startsWith("lcm-restore-e2e-proc-")) rmSync(join(tmpdir(), f), { force: true });
  }
});

describe("Flow 20: hooks via `node lcm.mjs` with piped stdin", { timeout: 120_000 }, () => {
  it("compact --hook prints the summary and exits 0", async () => {
    const h = handle!;
    const session_id = "e2e-proc-compact";
    await h.client.post("/ingest", {
      session_id,
      cwd: h.tmpDir,
      messages: [
        { role: "user", content: "Hello, can you help me with my project?", tokenCount: 10 },
        { role: "assistant", content: "Of course! I am happy to help you.", tokenCount: 10 },
      ],
    });
    const r = await runHook(["compact", "--hook"], JSON.stringify({ session_id, cwd: h.tmpDir, trigger: "auto" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).not.toBe("");
  });

  it("restore exits 0", async () => {
    const r = await runHook(["restore"], payload({ source: "startup" }));
    expect(r.status, r.stderr).toBe(0);
  });

  it("user-prompt always emits the learning instruction", async () => {
    const r = await runHook(["user-prompt"], payload({ prompt: "always use pnpm in this repo" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("<learning-instruction>");
  });

  it("post-tool is silent and exits 0", async () => {
    const r = await runHook(
      ["post-tool"],
      payload({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which db?" }] }, tool_response: "postgres" }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("post-tool accepts a PostToolUseFailure payload silently", async () => {
    const r = await runHook(
      ["post-tool"],
      payload({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nboom" }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("session-snapshot exits 0 with a real transcript", async () => {
    const h = handle!;
    const r = await runHook(["session-snapshot"], payload({ transcript_path: h.syntheticFixturePath }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("session-end exits 0 with a real transcript", async () => {
    const h = handle!;
    const r = await runHook(["session-end"], payload({ transcript_path: h.syntheticFixturePath, reason: "exit" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
  });

  it.each(HOOK_COMMANDS)("%s exits 0 on empty stdin", async (...args) => {
    const r = await runHook(args, "");
    expect(r.status, r.stderr).toBe(0);
  });

  it.each(HOOK_COMMANDS)("%s exits 0 on malformed stdin", async (...args) => {
    const r = await runHook(args, "not json {{{");
    expect(r.status, r.stderr).toBe(0);
  });
});
