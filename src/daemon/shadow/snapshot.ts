import { readFileSync } from "node:fs";
import { SessionCapture } from "../../capture.js";
import { openStandaloneLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { normalizeMessageContent } from "../../message-content.js";
import { parseClaudeTranscriptRecord } from "../../transcript.js";
import { ScrubEngine } from "../../scrub.js";
import { projectDbPath, projectId } from "../project.js";
import { openProject } from "../project-group.js";
import { withProjectMutation } from "../project-queue.js";
import { readCompactionContext } from "../compaction-context.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { digest, type ShadowOriginal, type ShadowSnapshot } from "./types.js";
import { ShadowStoreError } from "./store.js";

export async function captureShadowSnapshot(paths: LcmPaths, scrubber: ScrubEngine,
  input: { cwd: string; sessionId: string; boundaryUuid: string; transcriptPath?: string }): Promise<{ snapshot: ShadowSnapshot; conversationId: number }> {
  openProject(input.cwd, paths);
  return withProjectMutation(projectId(input.cwd), async () => {
    const db = openStandaloneLcmConnection(projectDbPath(input.cwd, paths));
    try {
      runLcmMigrations(db);
      const capture = new SessionCapture(db, projectId(input.cwd), scrubber, paths);
      const captured = await capture.captureTranscript({ ...input, client: "claude", requireComplete: true, captureThroughUuid: input.boundaryUuid });
      if (!captured?.verification?.verified || !captured.verification.complete || !captured.verification.boundaryFound)
        throw new ShadowStoreError("Capture boundary is unverified", 422);
      const raw = readFileSync(captured.transcriptPath, "utf8");
      const index = new Map<string, { uuid?: string; origin: ShadowOriginal["origin"] }[]>();
      let lastUuid: string | undefined;
      for (const line of raw.split("\n").filter(line => line.trim())) {
        const row = JSON.parse(line);
        const parsed = parseClaudeTranscriptRecord(line).message;
        if (!parsed) continue;
        lastUuid = row.uuid;
        const key = JSON.stringify([parsed.role, normalizeMessageContent(scrubber.scrub(parsed.content))]);
        const origin = row.type === "user" && parsed.role === "user" && !row.isMeta && !row.isCompactSummary ? "user" : "other";
        index.set(key, [...(index.get(key) ?? []), { uuid: row.uuid, origin }]);
      }
      if (lastUuid !== input.boundaryUuid) throw new ShadowStoreError("Source has model-visible content after the cut", 422);
      const window = await readCompactionContext(capture.summaryStore, captured.conversationId, 65_536);
      if (window.status !== "ready" || !window.valid) throw new ShadowStoreError(`Context is unavailable: ${window.status}`, 422);
      const ids = new Set(window.capturedMessageIds);
      const records = (await capture.conversationStore.getMessages(captured.conversationId)).filter(row => ids.has(row.messageId));
      const originals: ShadowOriginal[] = records.map(row => {
        const matches = index.get(JSON.stringify([row.role, row.content])) ?? [];
        const matched = matches.length === 1 ? matches[0] : undefined;
        return { id: row.messageId, seq: row.seq, role: row.role, text: row.content, origin: matched?.origin ?? "unknown", ...(matched?.uuid ? { uuid: matched.uuid } : {}) };
      });
      if (originals.length !== ids.size || originals.some(row => !index.has(JSON.stringify([row.role, row.text]))))
        throw new ShadowStoreError("Captured originals do not match the source", 422);
      if (readFileSync(captured.transcriptPath, "utf8") !== raw) throw new ShadowStoreError("Source changed during snapshot", 422);
      const { capturedMessageIds, renderedMessageIds, summaryCoverage, uncoveredMessageIds, valid } = window;
      return { conversationId: captured.conversationId, snapshot: { version: 1, originals, engineMessages: [], sourceHash: digest(raw),
        window: { text: window.text, coverage: { capturedMessageIds, renderedMessageIds, summaryCoverage, uncoveredMessageIds, valid } } } };
    } finally { db.close(); }
  });
}
