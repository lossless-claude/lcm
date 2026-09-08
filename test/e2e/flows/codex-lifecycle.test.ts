import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, openProjectDb, type HarnessHandle } from "../harness.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "dist/bin/lcm.js");
const sessionId = "cab029fa-2000-4000-8000-123456789abc";
const fact = "Quartz migration uses the cobalt ledger with a seven day retention window";
let harness: HarnessHandle;
let fakeHome: string;
let transcript: string;

function record(role: "user" | "assistant", content: string) {
  return JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: {
    type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: content }],
  } }) + "\n";
}

function runHook(event: string, extra: Record<string, unknown> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "codex-hook"], {
      cwd: harness.tmpDir,
      env: { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: undefined },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stderr || "Codex hook timed out")); }, 25_000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify({
      hook_event_name: event, session_id: sessionId, cwd: harness.tmpDir, transcript_path: transcript, ...extra,
    }));
  });
}

function messageCount(): number {
  const { db, close } = openProjectDb(harness.tmpDir);
  try {
    return (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
  } finally { close(); }
}

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error("Build the CLI before running Codex lifecycle process tests");
  harness = await createHarness("mock");
  fakeHome = mkdtempSync(join(tmpdir(), "lcm-codex-hook-home-"));
  mkdirSync(join(fakeHome, ".lossless-claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".lossless-claude/config.json"), JSON.stringify({ daemon: { port: harness.daemonPort } }));
  transcript = join(harness.tmpDir, "codex-rollout.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: harness.tmpDir } }) + "\n");
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

describe("Codex lifecycle through the built CLI and real daemon", { timeout: 60_000 }, () => {
  it("captures each turn, recalls it, resumes it, and preserves memory through compaction", async () => {
    const initial = await runHook("SessionStart", { source: "startup" });
    expect(initial.code, initial.stderr).toBe(0);
    appendFileSync(transcript, record("user", fact) + record("assistant", "I will use the cobalt ledger for the Quartz migration."));

    const stopped = await runHook("Stop");
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toBe("");
    expect(messageCount()).toBe(2);
    await runHook("Stop");
    await runHook("SessionEnd", { reason: "other" });
    expect(messageCount()).toBe(2);

    // A partial write cannot consume the next message's cursor position.
    const next = record("user", "Keep the cobalt ledger in the Quartz migration deployment.");
    appendFileSync(transcript, next.slice(0, 45));
    await runHook("Stop");
    expect(messageCount()).toBe(2);
    appendFileSync(transcript, next.slice(45));
    await runHook("Interrupt");
    expect(messageCount()).toBe(3);

    const recalled = await runHook("UserPromptSubmit", { prompt: "Quartz migration cobalt ledger retention" });
    expect(recalled.code, recalled.stderr).toBe(0);
    expect(JSON.parse(recalled.stdout).hookSpecificOutput.additionalContext).toContain("cobalt ledger");
    const unrelated = await runHook("UserPromptSubmit", { prompt: "xylophone zeppelin marmalade" });
    expect(unrelated.stdout).toBe("");

    const resumed = await runHook("SessionStart", { source: "resume" });
    expect(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext).toContain("cobalt ledger");

    for (const trigger of ["manual", "auto"]) {
      const compact = await runHook("PreCompact", { trigger });
      expect(compact.code, compact.stderr).toBe(0);
      expect(compact.stdout).toBe("");
      const restored = await runHook("SessionStart", { source: "compact" });
      const context = JSON.parse(restored.stdout).hookSpecificOutput.additionalContext;
      expect(context).toContain("cobalt ledger");
      expect(context).not.toContain("CLAUDE.md");
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(16_000);
    }
    expect(messageCount()).toBe(3);

    const freshId = "cab029fa-2000-4000-8000-987654321abc";
    const freshTranscript = join(harness.tmpDir, "new-codex-rollout.jsonl");
    writeFileSync(freshTranscript, JSON.stringify({ type: "session_meta", payload: { id: freshId, cwd: harness.tmpDir } }) + "\n");
    const fresh = await runHook("SessionStart", {
      session_id: freshId, transcript_path: freshTranscript, source: "startup",
    });
    expect(JSON.parse(fresh.stdout).hookSpecificOutput.additionalContext).toContain("cobalt ledger");
    expect(existsSync(join(fakeHome, ".claude/settings.json"))).toBe(false);
  });
});
