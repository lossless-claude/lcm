import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());
const dirs: string[] = [];

function writeTranscript(cwd: string, sessionId: string, messages: number): string {
  const transcriptPath = join(cwd, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, Array.from({ length: messages }, (_, index) => JSON.stringify({
    message: { role: index % 2 ? "assistant" : "user", content: `message ${index} ${"content for compaction ".repeat(100)}` },
  })).join("\n") + "\n");
  return transcriptPath;
}

async function readSummaryCount(cwd: string, sessionId: string): Promise<number> {
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    const conversation = await new ConversationStore(db).getOrCreateConversation(sessionId);
    return (await new SummaryStore(db).getSummariesByConversation(conversation.conversationId)).length;
  } finally {
    db.close();
  }
}

function mockRes() {
  return { writeHead: vi.fn().mockReturnThis(), end: vi.fn() } as any;
}

describe("compaction.liveLeafTrigger", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await daemon?.stop();
    daemon = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is off by default and must be a boolean", () => {
    expect(loadDaemonConfig("/nonexistent").compaction.liveLeafTrigger).toBe(false);
    expect(() => loadDaemonConfig("/nonexistent", { compaction: { liveLeafTrigger: "yes" } } as any))
      .toThrow("compaction.liveLeafTrigger must be a boolean");
  });

  it.each([
    { name: "requests an unforced live compaction once the raw backlog reaches a leaf chunk", enabled: true, chunk: "1000", source: undefined, expected: 1 },
    { name: "requests nothing while the setting is off", enabled: false, chunk: "1000", source: undefined, expected: 0 },
    { name: "requests nothing below a leaf chunk", enabled: true, chunk: "1000000", source: undefined, expected: 0 },
    { name: "requests nothing for an import", enabled: true, chunk: "1000", source: "import", expected: 0 },
  ])("$name", async ({ enabled, chunk, source, expected }) => {
    vi.stubEnv("LCM_LEAF_CHUNK_TOKENS", chunk);
    const cwd = mkdtempSync(join(tmpdir(), "lcm-live-leaf-"));
    dirs.push(cwd);
    const transcriptPath = writeTranscript(cwd, "live-leaf", 20);
    const requestCompaction = vi.fn();
    const config = loadDaemonConfig("/nonexistent", { compaction: { liveLeafTrigger: enabled } } as any);
    const res = mockRes();
    await createIngestHandler(config, paths, undefined, undefined, requestCompaction)({} as any, res, JSON.stringify({
      session_id: "live-leaf", cwd, transcript_path: transcriptPath, ...(source ? { source } : {}),
    }));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(requestCompaction).toHaveBeenCalledTimes(expected);
    if (expected) expect(requestCompaction).toHaveBeenCalledWith({
      session_id: "live-leaf", cwd, skip_ingest: true, work_class: "live", force: false, client: undefined,
    });
  });

  it("summarizes a live session in the background after ingest", async () => {
    vi.stubEnv("LCM_LEAF_CHUNK_TOKENS", "1000");
    const cwd = mkdtempSync(join(tmpdir(), "lcm-live-leaf-daemon-"));
    dirs.push(cwd);
    const transcriptPath = writeTranscript(cwd, "live-leaf-daemon", 20);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", {
      daemon: { port: 0 }, summarizer: { mock: true }, compaction: { liveLeafTrigger: true },
    } as any));
    const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "live-leaf-daemon", cwd, transcript_path: transcriptPath }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await vi.waitFor(async () => expect(await readSummaryCount(cwd, "live-leaf-daemon")).toBeGreaterThan(0),
      { timeout: 10_000, interval: 100 });
  }, 20_000);
});
