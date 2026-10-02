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
