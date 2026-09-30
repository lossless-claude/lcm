import { runLcmMigrations } from "../../src/db/migration.js";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { projectDbPath, projectId } from "../../src/daemon/project.js";
import { SessionCapture } from "../../src/capture.js";
import { ScrubEngine } from "../../src/scrub.js";
import { CompactionEngine, compactEngineConfig } from "../../src/compaction.js";
import { createPromoteHandler } from "../../src/daemon/routes/promote.js";
import { invokeRoute } from "../../src/daemon/routes/session-end.js";
import { recordPostToolEvents } from "../../src/hooks/tool-events.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import type { LcmPaths } from "../../src/lcm-paths.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { expect, vi } from "vitest";

export async function emptyWorkerConversation(cwd: string, sessionId: string, paths: LcmPaths): Promise<void> {
  const { openProject } = await import("../../src/daemon/project-group.js");
  openProject(cwd, paths);
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try { runLcmMigrations(db); await new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths).write({ sessionId, messages: [] }); }
  finally { closeLcmConnection(path); }
}

export async function assertWorkerCanaryAbsent(input: {
  cwd: string; sessionId: string; paths: LcmPaths; canary: string;
}): Promise<void> {
  const { cwd, sessionId, paths, canary } = input;
  recordPostToolEvents({ cwd, session_id: sessionId, tool_name: "Bash", tool_input: { command: `git commit -m ${canary}` } }, paths);
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    const capture = new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths);
    await capture.write({ sessionId, messages: [{ role: "assistant", content: canary, tokenCount: 100,
      parts: [{ type: "text", text: canary }] }] });
    const conversation = await capture.conversationStore.getConversationBySessionId(sessionId);
    const summarize = vi.fn(async () => canary);
    await new CompactionEngine(capture.conversationStore, capture.summaryStore,
      { ...compactEngineConfig({ env: {} }), freshTailCount: 0, leafMinFanout: 1 }).compact({
        conversationId: conversation!.conversationId, tokenBudget: 100, force: true, summarize,
      });
    const config = loadDaemonConfig("/nonexistent", { compaction: { promotionThresholds: { minDepth: 0 } } }, {});
    await invokeRoute(createPromoteHandler(config, paths), { cwd });
    expect(summarize).not.toHaveBeenCalled();
    for (const table of ["messages", "message_parts", "summaries", "messages_fts", "summaries_fts", "promoted", "promoted_fts"]) {
      expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
    }
    const events = new EventsDb(eventsDbPath(cwd, paths));
    try { expect(events.getUnprocessed()).toEqual([]); } finally { events.close(); }
  } finally { closeLcmConnection(path); }
}

