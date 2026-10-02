import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { projectDir, projectDbPath } from "../../src/daemon/project.js";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";

let root: string, cwd: string, paths: LcmPaths, daemon: DaemonInstance, token: string, transcript: string;
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
async function boot() {
  daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 }, llm: { provider: "disabled" },
    summarizer: { language: "en" }, security: { sensitivePatterns: ["PRIVATE_WORD"] } }, {}), { paths, tokenPath: paths.tokenPath });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lcm-shadow-")); cwd = join(root, "work"); mkdirSync(cwd);
  paths = createLcmPaths(join(root, "lcm")); ensureAuthToken(paths.tokenPath); token = readAuthToken(paths.tokenPath)!;
  transcript = join(cwd, "session.jsonl");
  writeFileSync(transcript, [
    { uuid: "one", type: "user", message: { role: "user", content: "Keep tests. PRIVATE_WORD" } },
    { uuid: "two", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "tool evidence" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  await boot();
});
afterEach(async () => { await daemon.stop(); rmSync(root, { recursive: true, force: true }); });
async function post(route: string, body: unknown, auth = true) {
  const response = await fetch(`http://127.0.0.1:${daemon.address().port}/compaction-shadow/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
function startInput(cut_id = "cut-a") { return { cwd, session_id: "session", cut_id, trigger: "manual", model: "session-model-id", boundary_uuid: "two", transcript_path: transcript }; }
function dir(cut = "cut-a") { return join(projectDir(cwd, paths), "compaction-shadow", cut); }
function artifact(name: string, cut = "cut-a") { return JSON.parse(readFileSync(join(dir(cut), name), "utf8")); }
async function start(cut = "cut-a") {
  const result = await post("start", startInput(cut)); expect(result.status).toBe(200); expect(result.body.admitted).toBe(true); return result.body;
}
function binding(cut: any) { return { cwd, session_id: "session", cut_id: cut.cut.cutId, snapshot_hash: cut.cut.snapshotHash }; }
function native(cut: any, text = "  native summary\n") {
  return { ...binding(cut), record: { text, outcome: "answered", usage, durationMs: 10, tail: [{ role: "user", text: "PRIVATE_WORD", handle: "kept" }] } };
}
function arm(cut: any, label = "A") {
  return { ...binding(cut), arm: label, attempt_id: "first", record: { text: "PRIVATE_WORD", header: null, outcome: "api-error", requestedModel: "session-model-id", usage, durationMs: 12, inputHash: cut.cut.snapshotHash, promptHash: "a".repeat(64) } };
}
describe("daemon compaction shadow artifacts", () => {
  it("admits without benchmark policy and freezes verified all-role raw sources", async () => {
    const cut = await start();
    expect(cut.snapshot.originals.map((row: any) => row.role)).toEqual(["user", "tool"]);
    expect(cut.snapshot.window.coverage.uncoveredMessageIds).toEqual([]);
    expect(cut.snapshot.window.text).toContain("tool evidence");
    expect(cut.cut.model).toBe("session-model-id");
    expect(artifact("manifest.json").state).toBe("pending");
  });
  it("skips an excluded project before Capture or storage", async () => {
    writeFileSync(join(paths.home, "bench-corpora.json"), JSON.stringify({ exclude: [cwd] }));
    writeFileSync(transcript, "malformed content\n");
    expect(await post("start", startInput())).toMatchObject({ status: 200, body: { admitted: false, reason: "excluded" } });
    expect(existsSync(projectDbPath(cwd, paths))).toBe(false);
    expect(existsSync(dir())).toBe(false);
  });
  it("recognizes a substring exclusion for a not-yet-captured project", async () => {
    writeFileSync(join(paths.home, "bench-corpora.json"), JSON.stringify({ excludeCwdContaining: ["work"] }));
    expect((await post("start", startInput())).body.admitted).toBe(false);
    expect(existsSync(projectDbPath(cwd, paths))).toBe(false);
  });
  it("refuses an absent or stale boundary instead of freezing post-cut content", async () => {
    expect((await post("start", { ...startInput(), boundary_uuid: "absent" })).status).toBe(422);
    expect((await post("start", { ...startInput(), boundary_uuid: "one" })).status).toBe(422);
    expect(existsSync(dir())).toBe(false);
  });
  it("refuses incomplete JSONL", async () => {
    appendFileSync(transcript, '{"uuid":"partial"');
    expect((await post("start", startInput())).status).toBe(422);
    expect(existsSync(dir())).toBe(false);
  });
  it("leaves an admitted snapshot unchanged as the transcript grows", async () => {
    const first = await start();
    appendFileSync(transcript, JSON.stringify({ uuid: "three", type: "user", message: { role: "user", content: "later secret task" } }) + "\n");
    const second = await post("start", { ...startInput("cut-b"), boundary_uuid: "three" });
    expect(second.body.snapshot.window.text).toContain("later secret task");
    expect(artifact("snapshot.json")).toEqual(first.snapshot);
    expect(first.snapshot.window.text).not.toContain("later secret task");
  });
  it("scrubs persisted native and arm text, preserves native whitespace and exact cache usage", async () => {
    const cut = await start();
    expect((await post("native", native(cut))).status).toBe(200);
    expect((await post("arm", arm(cut))).status).toBe(200);
    expect(artifact("native.json").text).toBe("  native summary\n");
    expect(artifact("native.json").rawTextBytes).toBe(17);
    expect(artifact("arm-A-first.json").usage).toEqual(usage);
    for (const name of readdirSync(dir())) expect(readFileSync(join(dir(), name), "utf8")).not.toContain("PRIVATE_WORD");
  });
  it("pairs out-of-order concurrent results without losing any arm", async () => {
    const cut = await start();
    const results = await Promise.all([post("arm", arm(cut, "B")), post("native", native(cut)), post("arm", arm(cut, "A")), post("arm", arm(cut, "C"))]);
    expect(results.map(result => result.status)).toEqual([200, 200, 200, 200]);
    expect(artifact("manifest.json").state).toBe("complete");
    expect(readdirSync(dir()).filter(name => name.startsWith("arm-"))).toHaveLength(3);
  });
  it("accepts identical delivery retries and rejects a changed result or cut identity", async () => {
    const cut = await start();
    expect((await post("start", startInput())).body.cut.snapshotHash).toBe(cut.cut.snapshotHash);
    expect((await post("native", native(cut))).status).toBe(200);
    expect((await post("native", native(cut))).status).toBe(200);
    expect((await post("native", native(cut, "different"))).status).toBe(409);
    expect((await post("arm", { ...arm(cut), snapshot_hash: "b".repeat(64) })).status).toBe(409);
    expect((await post("start", { ...startInput(), model: "other" })).status).toBe(409);
  });
  it("marks stranded records incomplete on daemon restart", async () => {
    await start(); await daemon.stop(); await boot();
    expect(artifact("manifest.json").state).toBe("incomplete");
  });
  it("prunes expired shadow cuts while preserving unrelated project files", async () => {
    await start();
    const manifest = artifact("manifest.json"); manifest.expiresAt = new Date(0).toISOString();
    writeFileSync(join(dir(), "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(projectDir(cwd, paths), "unrelated.txt"), "keep");
    await daemon.stop(); await boot();
    expect(existsSync(dir())).toBe(false);
    expect(readFileSync(join(projectDir(cwd, paths), "unrelated.txt"), "utf8")).toBe("keep");
  });
  it("rejects traversal and malformed accounting before writing", async () => {
    expect((await post("start", startInput("../escape"))).status).toBe(400);
    const cut = await start(); const request = arm(cut); request.record.usage = { ...usage, output_tokens: -1 };
    expect((await post("arm", request)).status).toBe(400);
    expect(existsSync(join(dir(), "arm-A-first.json"))).toBe(false);
  });
  it("requires daemon authentication", async () => {
    expect((await post("start", startInput(), false)).status).toBe(401);
  });
  it("accepts concurrent identical cut admission", async () => {
    const results = await Promise.all([post("start", startInput()), post("start", startInput())]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results[0].body.cut.snapshotHash).toBe(results[1].body.cut.snapshotHash);
  });
  it("keeps native daemon startup available despite corrupt or linked shadow artifacts", async () => {
    await start(); writeFileSync(join(dir(), "manifest.json"), "broken JSON");
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(projectDir(cwd, paths), "compaction-shadow", "linked"));
    await daemon.stop(); await boot();
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect((await fetch(`http://127.0.0.1:${daemon.address().port}/health`)).status).toBe(200);
  });
  it("does not require a valid evaluation policy for admission", async () => {
    writeFileSync(join(paths.home, "bench-corpora.json"), "broken JSON");
    expect((await start()).cut.state).toBe("pending");
  });
  it("preserves bounded failure classification and completion options without provider bodies", async () => {
    const cut = await start();
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, status: 400, errorKind: "invalid_request",
      options: { maxTokens: 2000, effort: "high" }, providerBody: "PRIVATE_WORD" } })).status).toBe(200);
    expect(artifact("arm-A-first.json")).toMatchObject({ status: 400, errorKind: "invalid_request", options: { maxTokens: 2000, effort: "high" } });
    expect(artifact("arm-A-first.json")).not.toHaveProperty("providerBody");
  });
});
