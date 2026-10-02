import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompactHandler } from "../../src/daemon/routes/compact.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { lcmHome } from "../../src/lcm-home.js";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath } from "../../src/daemon/project.js";
import { WorkerStore } from "../../src/store/worker-store.js";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
import { noopDaemonLog } from "../../src/daemon/log.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const paths = createLcmPaths(lcmHome());
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-context-")); dirs.push(cwd);
  const path = join(cwd, "session.jsonl");
  writeFileSync(path, [
    { uuid: "one", message: { role: "user", content: "source café" } },
    { uuid: "two", message: { role: "user", content: [{ type: "tool_result", content: "tool evidence" }] } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const config = loadDaemonConfig("/missing", { summarizer: { mock: true, language: "en" } }, {});
  const handler = createCompactHandler(config, paths);
  const request = { cwd, session_id: "session", transcript_path: path, client: "claude", capture_required: true,
    render_context: true, context_budget_bytes: 65536, capture_through_uuid: "two", compaction_summary_model: "pool" };
  return { cwd, path, handler, request };
}
async function invoke(handler: ReturnType<typeof createCompactHandler>, input: unknown) {
  let status = 0; let body: any;
  await handler({} as any, { writeHead: (code: number) => { status = code; }, end: (data: string) => { body = JSON.parse(data); } } as any, JSON.stringify(input));
  return { status, body };
}
describe("complete /compact context", () => {
  it("defaults to the configured pipeline and reports a missing summarizer explicitly", async () => {
    const { request } = fixture();
    const config = loadDaemonConfig("/missing", { llm: { provider: "disabled" }, summarizer: { language: "en" } }, {});
    const result = await invoke(createCompactHandler(config, paths), { ...request, compaction_summary_model: undefined });
    expect(result.status).toBe(200);
    expect(result.body.contextWindow.status).toBe("no-summarizer");
  });

  it("reports exclusion when a worker gate is installed after initial admission", async () => {
    const { handler, request, cwd } = fixture();
    await invoke(handler, request);
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      const pending = invoke(handler, request);
      new WorkerStore(db).exclude("session", cwd);
      expect((await pending).body.contextWindow.status).toBe("excluded");
    } finally { db.close(); }
  });

  it("reports exclusion when a worker gate changes after Capture and before summary setup", async () => {
    const { handler, request, cwd } = fixture();
    await invoke(handler, request);
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    const config = loadDaemonConfig("/missing", { summarizer: { mock: true, language: "en" } }, {});
    const log = { ...noopDaemonLog, write: (_level: string, event: string) => {
      if (event === "precompact.capture") new WorkerStore(db).exclude("session", cwd);
    } };
    try {
      const result = await invoke(createCompactHandler(config, paths, undefined, log), request);
      expect(result.body.contextWindow.status).toBe("excluded");
    } finally { db.close(); }
  });

  it("reports the bounded UUID scan as an explicit unavailable context", async () => {
    const { handler, request, path } = fixture();
    appendFileSync(path, JSON.stringify({ type: "progress", padding: "x".repeat(2 * 1024 * 1024) }) + "\n");
    appendFileSync(path, JSON.stringify({ uuid: "recent", message: { role: "user", content: "recent" } }) + "\n");
    expect((await invoke(handler, { ...request, capture_through_uuid: "recent" })).body.contextWindow.status).toBe("ready");
    const result = await invoke(handler, request);
    expect(result.body.contextWindow.status).toBe("boundary-scan-limit");
    expect(result.body.contextWindow.text).toBeUndefined();
  });

  it("distinguishes failed summaries from a successful Capture", async () => {
    const { path, request } = fixture();
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => JSON.stringify({ uuid: `failure-${i}`,
      message: { role: i % 2 ? "assistant" : "user", content: `message ${i} ${"source ".repeat(200)}` } })).join("\n") + "\n");
    const jobs = new SummarizeJobStore();
    const config = loadDaemonConfig("/missing", { llm: { provider: "disabled" }, summarizer: { language: "en" } }, {});
    const pending = invoke(createCompactHandler(config, paths, jobs), { ...request, capture_through_uuid: "failure-19",
      summary_via_requester: true, requester_session_id: "session", compaction_summary_model: "sonnet" });
    const job = await jobs.next("session");
    try {
      jobs.answer(job!.id, { error: "provider refused" });
      const result = await pending;
      expect(result.body.captureOutcome.status).toBe("completed");
      expect(result.body.contextWindow.status).toBe("summary-failed");
    } finally { jobs.close(); await pending; }
  });
  it("uses only the configured worker pool for the pool choice", async () => {
    const { path, request } = fixture();
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => JSON.stringify({ uuid: `pool-${i}`,
      message: { role: i % 2 ? "assistant" : "user", content: `message ${i} ${"source ".repeat(200)}` } })).join("\n") + "\n");
    const jobs = new SummarizeJobStore();
    const config = loadDaemonConfig("/missing", { llm: { provider: "session-pool", fallbackProvider: "disabled" }, summarizer: { language: "en" } }, {});
    const result = invoke(createCompactHandler(config, paths, jobs), { ...request, capture_through_uuid: "pool-19" });
    const job = await jobs.nextWorker("worker");
    try {
      expect(job?.pool).toBe(true);
      expect(job?.purpose).toBeUndefined();
      expect(await jobs.next("session", undefined, false)).toBeNull();
      jobs.answer(job!.id, { text: "pool summary", providerId: "session-pool:haiku", usage: { input_tokens: 500, output_tokens: 3, estimated: false } }, "worker");
      expect((await result).body.providerId).toBe("session-pool:haiku");
    } finally { jobs.close(); await result; }
  });
  it("awaits requester drafts and refuses a concurrent sweep for the same ranges", async () => {
    const { cwd, path, request } = fixture();
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => JSON.stringify({ uuid: `row-${i}`,
      message: { role: i % 2 ? "assistant" : "user", content: `message ${i} ${"source ".repeat(200)}` } })).join("\n") + "\n");
    const jobs = new SummarizeJobStore();
    const config = loadDaemonConfig("/missing", { llm: { provider: "disabled" }, summarizer: { language: "en" } }, {});
    const handler = createCompactHandler(config, paths, jobs);
    const first = invoke(handler, { ...request, capture_through_uuid: "row-19", summary_via_requester: true,
      requester_session_id: "session", compaction_summary_model: "sonnet", operation_id: "owned", instructions: "Keep the migration rationale." });
    const job = await jobs.next("session");
    try {
      expect(job).toMatchObject({ purpose: "compaction", model: "sonnet" });
      expect(job!.prompt).toContain("Operator instructions:\nKeep the migration rationale.");
      const concurrent = await invoke(handler, { ...request, capture_through_uuid: "row-19", skip_ingest: true, capture_required: false, render_context: false });
      expect(concurrent.body.replayOutcome).toBe("skipped");
      jobs.answer(job!.id, { text: "compact source", providerId: "session:sonnet", usage: { input_tokens: 500, output_tokens: 3, estimated: false } });
      const result = await first;
      expect(result.body.contextWindow.status).toBe("ready");
      expect(result.body.providerId).toBe("session:sonnet");
      expect(result.body.providerLabel).toBe("Live session (sonnet)");
      const after = await invoke(handler, { ...request, capture_through_uuid: "row-19", summary_via_requester: true,
        requester_session_id: "session", compaction_summary_model: "sonnet", operation_id: "later" });
      expect(after.body.replayOutcome).toBe("no_work");
      expect(await jobs.next("session", undefined, false)).toBeNull();
    } finally { jobs.close(); await first; }
  });

  it.each([null, 3, "x".repeat(50_001)])("rejects invalid operator instructions", async instructions => {
    const { handler, request } = fixture();
    expect((await invoke(handler, { ...request, instructions })).status).toBe(400);
  });

  it.each(["image", "attachment"])("does not claim a source window from an %s-only user turn", async kind => {
    const { handler, request, path } = fixture();
    writeFileSync(path, JSON.stringify(kind === "image"
      ? { uuid: "media", message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "fixture" } }] } }
      : { uuid: "media", type: "attachment", attachment: { type: "file", content: "fixture" } }) + "\n");
    const { body } = await invoke(handler, { ...request, capture_through_uuid: "media" });
    expect(body.contextWindow.status).not.toBe("ready");
    expect(body.contextWindow.text).toBeUndefined();
  });

  it("expires a stalled sweep without publishing a late requester answer", async () => {
    const { cwd, path, request } = fixture();
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => JSON.stringify({ uuid: `row-${i}`,
      message: { role: i % 2 ? "assistant" : "user", content: `message ${i} ${"source ".repeat(200)}` } })).join("\n") + "\n");
    const jobs = new SummarizeJobStore();
    const config = loadDaemonConfig("/missing", { llm: { provider: "disabled" }, summarizer: { language: "en" }, compaction: { hookDeadlineMs: 1000 } }, {});
    const records: { level: string; event: string }[] = [];
    const log = { ...noopDaemonLog, write: (level: string, event: string) => { records.push({ level, event }); } };
    const handler = createCompactHandler(config, paths, jobs, log);
    const first = invoke(handler, { ...request, capture_through_uuid: "row-19", summary_via_requester: true,
      requester_session_id: "session", compaction_summary_model: "sonnet", operation_id: "expire" });
    const job = await jobs.next("session");
    try {
      const result = await first;
      expect(result.status).toBe(408);
      expect(result.body.contextWindow.status).toBe("deadline");
      expect(jobs.answer(job!.id, { text: "late summary" })).toBe("discarded");
      expect(records).not.toContainEqual({ level: "error", event: "compact.failed" });
      expect(records).toContainEqual({ level: "warn", event: "compact.deadline" });
      const events = new EventsDb(eventsDbPath(cwd, paths));
      try {
        expect(events.getHookObservationSummary("session")).toContainEqual(expect.objectContaining({ operation: "summary", reason: "deadline" }));
      } finally { events.close(); }
    } finally { jobs.close(); }
  });
  it("returns a marked, fenced complete window and exact coverage after verified Capture", async () => {
    const { handler, request } = fixture();
    const { status, body } = await invoke(handler, request);
    expect(status).toBe(200);
    expect(body.captureOutcome).toMatchObject({ status: "completed", verified: true });
    expect(body.contextWindow).toMatchObject({ status: "ready", version: 1, sessionId: "session", uncoveredMessageIds: [] });
    expect(body.contextWindow.text).toContain('<lcm-compaction-context version="1">');
    expect(body.contextWindow.text).toContain("User:\nsource café");
    expect(body.contextWindow.text).toContain("Tool:\ntool evidence");
    expect(body.contextWindow.renderedMessageIds).toEqual(body.contextWindow.capturedMessageIds);
  });
  it.each(["partial", "boundary"])("refuses an unverified %s snapshot", async kind => {
    const { handler, request, path } = fixture();
    if (kind === "partial") appendFileSync(path, '{"uuid":');
    const { body } = await invoke(handler, { ...request, ...(kind === "boundary" ? { capture_through_uuid: "absent" } : {}) });
    expect(body.contextWindow.status).toBe("capture-unverified");
    expect(body.contextWindow.text).toBeUndefined();
  });
  it("rejects an oversized window rather than truncating it", async () => {
    const { handler, request } = fixture();
    const { body } = await invoke(handler, { ...request, context_budget_bytes: 32 });
    expect(body.contextWindow.status).toBe("over-budget");
    expect(body.contextWindow.text).toBeUndefined();
  });
  it("does not nest its first built context on the next compaction", async () => {
    const { handler, request, path } = fixture();
    const first = (await invoke(handler, request)).body.contextWindow;
    appendFileSync(path, JSON.stringify({ uuid: "generated", message: { role: "user", content: first.text } }) + "\n");
    appendFileSync(path, JSON.stringify({ uuid: "new", message: { role: "user", content: "new material" } }) + "\n");
    const second = (await invoke(handler, { ...request, capture_through_uuid: "new" })).body.contextWindow;
    expect(second.status).toBe("ready");
    expect(second.text.match(/<lcm-compaction-context version="1">/g)).toHaveLength(1);
    expect(second.capturedMessageIds).toHaveLength(3);
    expect(second.bytes).toBeLessThanOrEqual(first.bytes + Buffer.byteLength("\n\nUser:\nnew material"));
  });
  it.each(["worker", "timeline"])("excludes a %s conversation even when raw content exists", async kind => {
    const { handler, request, cwd } = fixture();
    await invoke(handler, request);
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      if (kind === "worker") new WorkerStore(db).exclude("session", cwd);
      else db.prepare("UPDATE conversations SET is_timeline = 1 WHERE session_id = 'session'").run();
    } finally { db.close(); }
    const { body } = await invoke(handler, request);
    expect(body.contextWindow.status).toBe("excluded");
    expect(body.contextWindow.text).toBeUndefined();
  });
});
