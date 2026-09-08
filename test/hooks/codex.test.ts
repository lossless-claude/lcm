import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCodexHook, type CodexHookDeps } from "../../src/hooks/codex.js";

const identity = { session_id: "codex-session", cwd: "/repo", transcript_path: "/repo/session.jsonl" };
function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...identity, hook_event_name: event, ...extra });
}
function dependencies(responses: Record<string, unknown> = {}) {
  const post = vi.fn(async (path: string) => responses[path] ?? {});
  const connect = vi.fn(async () => true);
  return { post, connect, deps: { client: { post }, connect } as CodexHookDeps };
}
function outputContext(stdout: string) {
  return JSON.parse(stdout).hookSpecificOutput;
}

describe("Codex native lifecycle adapter", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function transcriptWith(records: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-codex-restore-dedup-"));
    temporaryDirectories.push(dir);
    const file = join(dir, "rollout.jsonl");
    writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    return file;
  }

  const restoredRecord = (role = "developer", text = "remember quartz") => ({
    type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });

  it("does not inject identical compact context already emitted by resume after the last compaction", async () => {
    const file = transcriptWith([{ type: "compacted" }, restoredRecord()]);
    const { post, deps } = dependencies({ "/restore": { context: "remember quartz" } });
    expect(await dispatchCodexHook(payload("SessionStart", { source: "compact", transcript_path: file }), deps))
      .toEqual({ exitCode: 0, stdout: "" });
    expect(post.mock.calls.map(([path]) => path)).toEqual(["/ingest", "/restore"]);
  });

  it.each([
    [restoredRecord(), { type: "compacted" }],
    [{ type: "compacted" }, restoredRecord(), { type: "compacted" }],
    [restoredRecord()],
    [{ type: "compacted" }, restoredRecord("user")],
    [{ type: "compacted" }, restoredRecord("developer", "different memory")],
  ])("restores when prior context is absent or predates the current compaction", async (...records) => {
    const file = transcriptWith(records);
    const { deps } = dependencies({ "/restore": { context: "remember quartz" } });
    const result = await dispatchCodexHook(payload("SessionStart", { source: "compact", transcript_path: file }), deps);
    expect(outputContext(result.stdout).additionalContext).toBe("remember quartz");
  });

  it("does not use an unvalidated transcript to suppress restoration", async () => {
    const file = transcriptWith([{ type: "compacted" }, restoredRecord()]);
    const { post, deps } = dependencies({ "/restore": { context: "remember quartz" } });
    post.mockRejectedValueOnce(new Error("transcript metadata mismatch"));
    const result = await dispatchCodexHook(payload("SessionStart", { source: "compact", transcript_path: file }), deps);
    expect(outputContext(result.stdout).additionalContext).toBe("remember quartz");
  });

  it.each(["{\"type\":\"compacted\"", "{broken}\n"])("does not suppress from an incomplete or malformed transcript snapshot", async (tail) => {
    const records = [{ type: "compacted" }, restoredRecord()];
    const file = transcriptWith(records);
    writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n" + tail);
    const { deps } = dependencies({ "/restore": { context: "remember quartz" } });
    const result = await dispatchCodexHook(payload("SessionStart", { source: "compact", transcript_path: file }), deps);
    expect(outputContext(result.stdout).additionalContext).toBe("remember quartz");
  });

  it.each(["startup", "resume", "clear", "compact"])("restores on %s after capturing pending transcript content", async (source) => {
    const { post, deps } = dependencies({ "/restore": { context: "Remember the quartz migration." } });
    const result = await dispatchCodexHook(payload("SessionStart", { source }), deps);
    expect(post.mock.calls.map(([path]) => path)).toEqual(["/ingest", "/restore"]);
    expect(post).toHaveBeenLastCalledWith("/restore", {
      session_id: identity.session_id, cwd: identity.cwd, source, client: "codex",
    }, expect.objectContaining({ timeoutMs: 10_000, signal: expect.any(AbortSignal) }));
    expect(outputContext(result.stdout)).toEqual({
      hookEventName: "SessionStart", additionalContext: "Remember the quartz migration.",
    });
    expect(result.exitCode).toBe(0);
  });

  it("injects prompt recall with memory IDs and a bounded request deadline", async () => {
    const { post, deps } = dependencies({ "/prompt-search": { hints: ["Quartz uses WAL."], ids: ["s-1"] } });
    const result = await dispatchCodexHook(payload("UserPromptSubmit", { prompt: "How does quartz store state?" }), deps);
    expect(post).toHaveBeenLastCalledWith("/prompt-search", expect.objectContaining({
      query: "How does quartz store state?", client: "codex", session_id: identity.session_id,
    }), expect.objectContaining({ timeoutMs: 5000 }));
    expect(outputContext(result.stdout).additionalContext).toContain("Quartz uses WAL.");
    expect(outputContext(result.stdout).additionalContext).toContain("s-1");
  });

  it("emits no context for an unrelated prompt", async () => {
    const { deps } = dependencies({ "/prompt-search": { hints: [] } });
    expect(await dispatchCodexHook(payload("UserPromptSubmit", { prompt: "unrelated" }), deps))
      .toEqual({ exitCode: 0, stdout: "" });
  });

  it.each(["Stop", "Interrupt", "SessionEnd"])("captures %s without asking Codex to continue or block", async (event) => {
    const { post, connect, deps } = dependencies();
    expect(await dispatchCodexHook(payload(event, { stop_hook_active: true }), deps)).toEqual({ exitCode: 0, stdout: "" });
    const shortDeadline = event === "Interrupt" || event === "SessionEnd";
    expect(post).toHaveBeenCalledExactlyOnceWith("/ingest", { ...identity, client: "codex" }, expect.objectContaining({ timeoutMs: shortDeadline ? 1500 : 5000 }));
    if (shortDeadline) expect(connect).not.toHaveBeenCalled();
  });

  it("ingests before compacting and leaves restore to the compact SessionStart", async () => {
    const { post, deps } = dependencies({ "/compact": { latestSummaryContent: "preserved fact" } });
    expect(await dispatchCodexHook(payload("PreCompact", { trigger: "auto" }), deps)).toEqual({ exitCode: 0, stdout: "" });
    expect(post.mock.calls.map(([path]) => path)).toEqual(["/ingest", "/compact"]);
    expect(post).toHaveBeenLastCalledWith("/compact", {
      session_id: identity.session_id, cwd: identity.cwd, client: "codex", skip_ingest: true,
    }, expect.objectContaining({ timeoutMs: 115_000 }));
  });

  it("restores existing memory even when transcript ingestion fails", async () => {
    const { post, deps } = dependencies({ "/restore": { context: "existing memory" } });
    post.mockRejectedValueOnce(new Error("partial transcript"));
    const result = await dispatchCodexHook(payload("SessionStart"), deps);
    expect(outputContext(result.stdout).additionalContext).toBe("existing memory");
  });

  it("can restore before a new transcript exists", async () => {
    const { post, deps } = dependencies({ "/restore": { context: "prior memory" } });
    await dispatchCodexHook(payload("SessionStart", { transcript_path: undefined }), deps);
    expect(post.mock.calls.map(([path]) => path)).toEqual(["/restore"]);
  });

  it("bounds non-ASCII context on code-point boundaries", async () => {
    const { deps } = dependencies({ "/restore": { context: "🔒".repeat(8000) } });
    const result = await dispatchCodexHook(payload("SessionStart"), deps);
    const context = outputContext(result.stdout).additionalContext;
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(16_000);
    expect(context).not.toContain("\uFFFD");
    expect(Array.from(context).every(c => c === "🔒")).toBe(true);
  });

  it.each(["{", "null", "[]", "{}", payload("PostCompact"), payload("Stop", { cwd: 4 })])("ignores malformed or unregistered input %s", async (input) => {
    const { connect, post, deps } = dependencies();
    expect(await dispatchCodexHook(input, deps)).toEqual({ exitCode: 0, stdout: "" });
    expect(connect).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not contact the daemon when it cannot connect", async () => {
    const { connect, post, deps } = dependencies();
    connect.mockResolvedValue(false);
    expect(await dispatchCodexHook(payload("SessionStart"), deps)).toEqual({ exitCode: 0, stdout: "" });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"])("fails open when %s requests fail", async (event) => {
    const { post, deps } = dependencies();
    post.mockRejectedValue(new Error("daemon request timed out"));
    expect(await dispatchCodexHook(payload(event, { prompt: "quartz" }), deps)).toEqual({ exitCode: 0, stdout: "" });
  });
});
