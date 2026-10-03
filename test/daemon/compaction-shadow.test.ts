import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { openDaemonLog, readDaemonLog } from "../../src/daemon/log.js";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { projectDir, projectDbPath } from "../../src/daemon/project.js";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { DatabaseSync } from "node:sqlite";
import { SummaryStore } from "../../src/store/summary-store.js";

let root: string, cwd: string, paths: LcmPaths, daemon: DaemonInstance, token: string, transcript: string, databaseFile: string;
const fileForProject = projectDbPath;
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
async function boot(patterns = ["PRIVATE_WORD"]) {
  daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 }, llm: { provider: "disabled" },
    summarizer: { language: "en" }, security: { sensitivePatterns: patterns } }, {}), { paths, tokenPath: paths.tokenPath,
    log: openDaemonLog({ path: join(paths.logsDir, "daemon.log"), level: "warn", maxSizeMB: 10, retentionDays: 7,
      globalPatterns: patterns, projectDirFor: cwd => projectDir(cwd, paths), version: "test" }),
  });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lcm-shadow-")); cwd = join(root, "work"); mkdirSync(cwd);
  paths = createLcmPaths(join(root, "lcm")); ensureAuthToken(paths.tokenPath); token = readAuthToken(paths.tokenPath)!;
  databaseFile = fileForProject(cwd, paths);
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
function startInput(cut_id = "cut-a") { return { cwd, session_id: "session", cut_id, trigger: "manual", model: "session-model-id", boundary_uuid: "two", transcript_path: transcript,
  engine_messages: [{ role: "user", text: "PRIVATE_WORD", handle: "kept" }] }; }
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
function databaseExists() { return existsSync(databaseFile); }
async function withSummaryStore(operation: (store: SummaryStore) => Promise<void>, connect: typeof DatabaseSync = DatabaseSync) {
  const db = new connect(databaseFile);
  try { await operation(new SummaryStore(db)); }
  finally { db.close(); }
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
    expect(databaseExists()).toBe(false);
    expect(existsSync(dir())).toBe(false);
  });
  it("recognizes a substring exclusion for a not-yet-captured project", async () => {
    writeFileSync(join(paths.home, "bench-corpora.json"), JSON.stringify({ excludeCwdContaining: ["work"] }));
    expect((await post("start", startInput())).body.admitted).toBe(false);
    expect(databaseExists()).toBe(false);
  });
  it("honors a valid corpus policy with a non-directory entry in projects", async () => {
    mkdirSync(paths.projectsDir, { recursive: true });
    writeFileSync(join(paths.projectsDir, ".DS_Store"), "not a project directory");
    writeFileSync(join(paths.home, "bench-corpora.json"), JSON.stringify({ excludeCwdContaining: ["work"] }));
    writeFileSync(transcript, "malformed content\n");
    expect(await post("start", startInput())).toEqual({ status: 200, body: { admitted: false, reason: "excluded" } });
    expect(databaseExists()).toBe(false);
    expect(existsSync(dir())).toBe(false);
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
  it.each(["unknown", "text", "order", "duplicate", "missing", "role", "ambiguous"])("rejects a native tail with %s correspondence to frozen engine messages", async defect => {
    const messages = [
      { role: "user", text: "first message", handle: "h1" },
      { role: "assistant", text: "second message", handle: "h2" },
      { role: "user", text: "third message", handle: "h3" },
    ];
    if (defect === "ambiguous") messages[0].handle = "h2";
    const admitted = await post("start", { ...startInput(), engine_messages: messages });
    expect(admitted.status).toBe(200);
    const tail: { role: string; text: string; handle?: string }[] = messages.slice(1).map(row => ({ ...row }));
    if (defect === "unknown") tail[0] = { ...tail[0], handle: "unknown_handle", text: "after-cut evidence" };
    if (defect === "text") tail[0].text = "after-cut evidence";
    if (defect === "order") tail.reverse();
    if (defect === "duplicate") tail[1] = { ...tail[0] };
    if (defect === "missing") delete tail[0].handle;
    if (defect === "role") tail[0].role = "user";
    const request = native(admitted.body);
    expect((await post("native", { ...request, record: { ...request.record, tail } })).status).toBe(409);
    expect(existsSync(join(dir(), "native.json"))).toBe(false);
  });
  it.each(["empty", "subsequence"])("accepts an %s native tail using current rules on both frozen and delivered text", async shape => {
    const messages = [
      { role: "user", text: "LATER_WORD", handle: "h1" },
      { role: "assistant", text: "omitted message", handle: "h2" },
      { role: "user", text: "last message", handle: "h3" },
    ];
    const admitted = await post("start", { ...startInput(), engine_messages: messages });
    expect(admitted.status).toBe(200);
    await daemon.stop(); await boot(["PRIVATE_WORD", "LATER_WORD"]);
    const request = native(admitted.body), tail = shape === "empty" ? [] : [messages[0], messages[2]];
    expect((await post("native", { ...request, record: { ...request.record, tail } })).status).toBe(200);
    expect(artifact("native.json").tail).toEqual(shape === "empty" ? [] : [{ ...messages[0], text: "[REDACTED]" }, messages[2]]);
  });
  it.each(["PRIVATE_WORD", "Bearer PRIVATE_WORD", "bad.handle", ""])("rejects unsafe engine and native handles (%s) without storing them", async handle => {
    const rejected = await post("start", { ...startInput(), engine_messages: [{ role: "user", text: "safe", handle }] });
    expect(rejected.status).toBe(400);
    expect(existsSync(dir())).toBe(false);
    const cut = await start();
    const request = native(cut); request.record.tail[0].handle = handle;
    expect((await post("native", request)).status).toBe(400);
    expect(existsSync(join(dir(), "native.json"))).toBe(false);
  });
  it.each(["session_id", "cut_id", "boundary_uuid"])("rejects sensitive %s instead of persisting or rewriting it", async field => {
    expect((await post("start", { ...startInput(), [field]: "PRIVATE_WORD" })).status).toBe(400);
  });
  it.each(["attempt_id", "summaryUuid", "source", "supersedes"])("rejects sensitive result identifier %s", async field => {
    const cut = await start();
    const request = field === "summaryUuid" ? { ...native(cut), record: { ...native(cut).record, summaryUuid: "PRIVATE_WORD" } }
      : { ...arm(cut), ...(field === "attempt_id" ? { attempt_id: "PRIVATE_WORD" } : {}),
        record: { ...arm(cut).record, header: field === "attempt_id" ? null : {
          version: 1, directives: [], intent: [], decisions: [{ text: "safe", sources: [field === "source" ? "[raw:PRIVATE_WORD:1]" : "[raw:cut-a:1]"],
            ...(field === "supersedes" ? { supersedes: ["PRIVATE_WORD"] } : {}) }], taskAndNextStep: [], openThreads: [], files: [], errors: [],
        } } };
    expect((await post(field === "summaryUuid" ? "native" : "arm", request)).status).toBe(400);
  });
  it("rejects unsafe source UUIDs before publishing a snapshot", async () => {
    const rows = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
    rows[0].uuid = "PRIVATE_WORD";
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    expect((await post("start", startInput())).status).toBe(400);
    expect(existsSync(dir())).toBe(false);
  });
  it("validates model label shapes on admission and every usage record", async () => {
    expect((await post("start", { ...startInput(), model: "Bearer PRIVATE_WORD" })).status).toBe(400);
    const cut = await start();
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, requestedModel: "Bearer PRIVATE_WORD" } })).status).toBe(400);
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, usageAttempts: [{ model: "Bearer PRIVATE_WORD", failed: true, usage }] } })).status).toBe(400);
  });
  it("preserves distinct model names in cuts and usage despite matching sensitive patterns", async () => {
    await daemon.stop(); await boot(["PRIVATE_WORD", "^(?:sonnet|opus)$"]);
    for (const [cutId, model] of [["model-one", "sonnet"], ["model-two", "opus"]]) {
      const request = { ...startInput(cutId), model, instructions: "PRIVATE_WORD" };
      const result = await post("start", request); expect(result.status).toBe(200);
      expect(artifact("manifest.json", cutId)).toMatchObject({ model, instructions: "[REDACTED]" });
      const record = { ...arm(result.body).record, requestedModel: model,
        usageAttempts: [{ model, failed: true, usage }] };
      expect((await post("arm", { ...arm(result.body), record })).status).toBe(200);
      expect(artifact("arm-A-first.json", cutId)).toMatchObject({ requestedModel: model, usageAttempts: [{ model }] });
      expect((await post("start", request)).status).toBe(200);
      expect((await post("start", { ...request, model: model === "sonnet" ? "opus" : "sonnet" })).status).toBe(409);
    }
    expect(artifact("manifest.json", "model-one").model).not.toBe(artifact("manifest.json", "model-two").model);
  });
  it.each(["vendor/sonnet.v1:beta", "7model-name", "model_name", "a".repeat(64)])("accepts the model-name alphabet and length in all fields (%s)", async model => {
    const result = await post("start", { ...startInput(), model }); expect(result.status).toBe(200);
    expect(result.body.cut.model).toBe(model);
    const record = { ...arm(result.body).record, requestedModel: model, usageAttempts: [{ model, failed: true, usage }] };
    expect((await post("arm", { ...arm(result.body), record })).status).toBe(200);
    expect(artifact("arm-A-first.json")).toMatchObject({ requestedModel: model, usageAttempts: [{ model }] });
  });
  it.each(["", "_bad", "-bad", ".bad", ":bad", "/bad", "son net", "model[1m]", "a".repeat(65), "sonnet\n"])("rejects invalid model names in all fields (%s)", async model => {
    expect((await post("start", { ...startInput(), model })).status).toBe(400);
    const cut = await start();
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, requestedModel: model } })).status).toBe(400);
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, usageAttempts: [{ model, failed: true, usage }] } })).status).toBe(400);
    expect(existsSync(join(dir(), "arm-A-first.json"))).toBe(false);
  });
  it.each(["errorKind", "inputHash", "promptHash"])("rejects sensitive identifier in %s metadata", async field => {
    const value = field === "errorKind" ? "private_word" : "a".repeat(64);
    await daemon.stop(); await boot(["PRIVATE_WORD", `^${value}$`]);
    const cut = await start();
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, [field]: value } })).status).toBe(400);
    expect(existsSync(join(dir(), "arm-A-first.json"))).toBe(false);
  });
  it("preserves accepted identifiers and source pointers exactly", async () => {
    const handle = "handle_abc-123";
    const result = await post("start", { ...startInput(), engine_messages: [{ role: "assistant", text: "PRIVATE_WORD", handle }] });
    expect(result.status).toBe(200);
    expect(result.body.snapshot.engineMessages[0].handle).toBe(handle);
    const request = native(result.body); request.record.tail[0].handle = handle; request.record.tail[0].role = "assistant";
    expect((await post("native", { ...request, record: { ...request.record, summaryUuid: "summary_123" } })).status).toBe(200);
    expect(artifact("native.json")).toMatchObject({ summaryUuid: "summary_123", tail: [{ handle }] });
    const header = { version: 1, directives: [], intent: [], decisions: [{ text: "safe", sources: ["[raw:cut-a:1]", "[sum:sum_known]"], supersedes: ["decision_1"] }],
      taskAndNextStep: [], openThreads: [], files: [], errors: [] };
    expect((await post("arm", { ...arm(result.body), record: { ...arm(result.body).record, header } })).status).toBe(200);
    expect(artifact("arm-A-first.json").header).toEqual(header);
  });
  it("scrubs historical summary text in the frozen window with current rules", async () => {
    const first = await start();
    await withSummaryStore(async store => {
      await store.insertSummary({ summaryId: "sum_old", conversationId: first.cut.conversationId,
        kind: "leaf", content: "Old PRIVATE_WORD summary", tokenCount: 8 });
      await store.linkSummaryToMessages("sum_old", first.snapshot.originals.map((row: any) => row.id));
      await store.replaceContextRangeWithSummary({ conversationId: first.cut.conversationId,
        startOrdinal: 0, endOrdinal: 1, summaryId: "sum_old" });
      const second = await start("cut-b");
      expect(second.snapshot.window.coverage.summaryCoverage).toEqual([
        { summaryId: "sum_old", messageIds: first.snapshot.originals.map((row: any) => row.id) },
      ]);
      expect(second.snapshot.window.text).toContain("Old");
      expect(second.snapshot.window.text).not.toContain("PRIVATE_WORD");
      expect(readFileSync(join(dir("cut-b"), "snapshot.json"), "utf8")).not.toContain("PRIVATE_WORD");
      expect((await store.getSummary("sum_old"))?.content).toBe("Old PRIVATE_WORD summary");
    });
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
  it("preserves model identity when retrying admission", async () => {
    const request = { ...startInput(), model: "PRIVATE_WORD" };
    const first = await post("start", request);
    expect(first.status).toBe(200);
    expect(first.body.cut.model).toBe("PRIVATE_WORD");
    const retry = await post("start", request);
    expect(retry.status).toBe(200);
    expect(retry.body.cut.snapshotHash).toBe(first.body.cut.snapshotHash);
    expect((await post("start", { ...request, model: "other" })).status).toBe(409);
  });
  it.each([
    { field: "model", value: "opus" }, { field: "instructions", value: "directive-two" },
    { field: "session_id", value: "other-session" }, { field: "boundary_uuid", value: "one" }, { field: "trigger", value: "auto" },
  ])("rejects a changed raw $field on retry even when redaction hides it", async ({ field, value }) => {
    await daemon.stop(); await boot(["PRIVATE_WORD", "^(?:sonnet|opus|directive-one|directive-two)$"]);
    const request = { ...startInput(), model: "sonnet", instructions: "directive-one" };
    const first = await post("start", request); expect(first.status).toBe(200);
    expect(first.body.cut.model).toBe("sonnet"); expect(first.body.cut.instructions).toBe("[REDACTED]");
    const before = readFileSync(join(dir(), "manifest.json"), "utf8");
    expect((await post("start", { ...request, [field]: value })).status).toBe(409);
    expect((await post("start", request)).status).toBe(200);
    expect(readFileSync(join(dir(), "manifest.json"), "utf8")).toBe(before);
    expect(artifact("manifest.json").model).toBe("sonnet"); expect(before).not.toContain("directive-one");
  });
  it("rejects changed raw instruction presence instead of comparing defaulted display text", async () => {
    await start();
    expect((await post("start", { ...startInput(), instructions: "" })).status).toBe(409);
  });
  it("refuses admission retries for legacy cuts with no raw identity digest", async () => {
    await start();
    const manifest = artifact("manifest.json"); delete manifest.requestIdentityHash;
    writeFileSync(join(dir(), "manifest.json"), JSON.stringify(manifest));
    expect((await post("start", startInput())).status).toBe(409);
  });
  it("rejects concurrent different model identities", async () => {
    await daemon.stop(); await boot(["PRIVATE_WORD", "^(?:sonnet|opus)$"]);
    const results = await Promise.all([post("start", { ...startInput(), model: "sonnet" }), post("start", { ...startInput(), model: "opus" })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  });
  it.each(["text", "handle", "role", "order", "added", "removed"])("rejects admission retries with changed raw engine message %s", async field => {
    await daemon.stop(); await boot(["PRIVATE_WORD", "^(?:private-one|private-two)$"]);
    const messages = [{ role: "user", text: "private-one", handle: "handle_1" }, { role: "assistant", text: "safe", handle: "handle_2" }];
    const request = { ...startInput(), engine_messages: messages };
    const first = await post("start", request); expect(first.status).toBe(200);
    expect(first.body.snapshot.engineMessages[0].text).toBe("[REDACTED]");
    const changed = structuredClone(messages);
    const mutations: Record<string, () => void> = {
      text: () => { changed[0].text = "private-two"; }, handle: () => { changed[0].handle = "handle_3"; },
      role: () => { changed[0].role = "assistant"; }, order: () => { changed.reverse(); },
      added: () => { changed.push({ role: "user", text: "extra", handle: "handle_3" }); }, removed: () => { changed.pop(); },
    };
    mutations[field]();
    expect((await post("start", { ...request, engine_messages: changed })).status).toBe(409);
    expect((await post("start", request)).status).toBe(200);
    expect(artifact("snapshot.json")).toEqual(first.body.snapshot);
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
  it.each(["project", "shadow", "cut"])("does not recover or prune through a linked %s directory", async level => {
    await start(); await daemon.stop();
    const manifest = artifact("manifest.json"); manifest.expiresAt = new Date(0).toISOString();
    writeFileSync(join(dir(), "manifest.json"), JSON.stringify(manifest));
    const levels = { project: projectDir(cwd, paths), shadow: join(projectDir(cwd, paths), "compaction-shadow"), cut: dir() };
    const outside = join(root, "outside"), linked = levels[level as keyof typeof levels];
    renameSync(linked, outside); symlinkSync(outside, linked);
    const target = { project: join(outside, "compaction-shadow", "cut-a"), shadow: join(outside, "cut-a"), cut: outside };
    const file = join(target[level as keyof typeof target], "manifest.json"), before = readFileSync(file, "utf8");
    await boot();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await fetch(`http://127.0.0.1:${daemon.address().port}/health`)).status).toBe(200);
  });
  it.each(["meta", "manifest"])("does not use a linked %s file during recovery", async field => {
    await start(); await daemon.stop();
    const manifest = artifact("manifest.json"); manifest.expiresAt = new Date(0).toISOString();
    writeFileSync(join(dir(), "manifest.json"), JSON.stringify(manifest));
    const path = field === "meta" ? join(projectDir(cwd, paths), "meta.json") : join(dir(), "manifest.json");
    const outside = join(root, "outside.json");
    renameSync(path, outside); symlinkSync(outside, path);
    const before = readFileSync(outside, "utf8");
    await boot();
    expect(existsSync(dir())).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe(before);
    expect((await fetch(`http://127.0.0.1:${daemon.address().port}/health`)).status).toBe(200);
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
  it.each([
    ["malformed JSON", "broken JSON"],
    ["invalid policy", JSON.stringify({ exclude: null })],
    ["unreadable policy", undefined],
  ])("refuses admission before Capture and logs a warning for %s", async (_case, policy) => {
    const file = join(paths.home, "bench-corpora.json");
    if (policy === undefined) mkdirSync(file);
    else writeFileSync(file, policy);
    expect(await post("start", startInput())).toEqual({ status: 200, body: { admitted: false, reason: "policy-unavailable" } });
    expect(databaseExists()).toBe(false);
    expect(existsSync(dir())).toBe(false);
    expect(readDaemonLog(join(paths.logsDir, "daemon.log"), { since: new Date(0) })).toContainEqual(expect.objectContaining({
      level: "warn", event: "compaction-shadow.policy_unavailable", cwd: realpathSync(cwd),
    }));
  });
  it("preserves bounded failure classification and completion options without provider bodies", async () => {
    const cut = await start();
    expect((await post("arm", { ...arm(cut), record: { ...arm(cut).record, status: 400, errorKind: "invalid_request",
      options: { maxTokens: 2000, effort: "high" }, providerBody: "PRIVATE_WORD" } })).status).toBe(200);
    expect(artifact("arm-A-first.json")).toMatchObject({ status: 400, errorKind: "invalid_request", options: { maxTokens: 2000, effort: "high" } });
    expect(artifact("arm-A-first.json")).not.toHaveProperty("providerBody");
  });
});
