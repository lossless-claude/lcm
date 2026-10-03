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
import { HTTP, digest, type ShadowOriginal, type ShadowSnapshot } from "./types.js";
import { ShadowStoreError } from "./store.js";
import { correlationId } from "./records.js";

type SnapshotInput = { cwd: string; sessionId: string; boundaryUuid: string; transcriptPath?: string };
export async function captureShadowSnapshot(paths: LcmPaths, scrubber: ScrubEngine,
  input: SnapshotInput): Promise<{ snapshot: ShadowSnapshot; conversationId: number }> {
  openProject(input.cwd, paths);
  return withProjectMutation(projectId(input.cwd), () => readSnapshot({ paths, scrubber, input, fileForProject: projectDbPath }));
}
/** SQLite construction and closure stay inside the project mutation lease. */
async function readSnapshot({ paths, scrubber, input, fileForProject }: { paths: LcmPaths; scrubber: ScrubEngine; input: SnapshotInput; fileForProject: typeof projectDbPath }): Promise<{ snapshot: ShadowSnapshot; conversationId: number }> {
  const db = openStandaloneLcmConnection(fileForProject(input.cwd, paths));
  try {
    runLcmMigrations(db);
    const capture = new SessionCapture(db, projectId(input.cwd), scrubber, paths);
    const captured = await capture.captureTranscript({ ...input, client: "claude", requireComplete: true, captureThroughUuid: input.boundaryUuid });
    requireVerifiedCapture(captured);
    const raw = readFileSync(captured.transcriptPath, "utf8");
    const index = indexOriginals(raw, scrubber, input.boundaryUuid);
    const window = await readCompactionContext(capture.summaryStore, captured.conversationId, { byteBudget: MAX_WINDOW_BYTES, includeItems: true });
    if (window.status !== "ready" || !window.valid) throw new ShadowStoreError(`Context is unavailable: ${window.status}`, HTTP.unprocessable);
    const ids = new Set(window.capturedMessageIds);
    const records = (await capture.conversationStore.getMessages(captured.conversationId)).filter(row => ids.has(row.messageId));
    const originals = originalsFromRecords(records, index);
    if (originals.length !== ids.size || originals.some(row => !index.has(JSON.stringify([row.role, row.text]))))
      throw new ShadowStoreError("Captured originals do not match the source", HTTP.unprocessable);
    if (readFileSync(captured.transcriptPath, "utf8") !== raw) throw new ShadowStoreError("Source changed during snapshot", HTTP.unprocessable);
    return { conversationId: captured.conversationId, snapshot: { version: 1,
      originals: originals.map(row => ({ ...row, text: scrubber.scrub(row.text) })), engineMessages: [], sourceHash: digest(raw),
      window: freezeWindow(window, scrubber) } };
  } finally { db.close(); }
}
function freezeWindow(window: Extract<Awaited<ReturnType<typeof readCompactionContext>>, { status: "ready" }>, scrubber: ScrubEngine): ShadowSnapshot["window"] {
  if (!window.items) throw new ShadowStoreError("Structured window is unavailable", HTTP.unprocessable);
  const { capturedMessageIds, renderedMessageIds, summaryCoverage, uncoveredMessageIds, valid } = window;
  return { text: scrubber.scrub(window.text), items: window.items.map(row => ({ ...row, content: scrubber.scrub(row.content) })),
    coverage: { capturedMessageIds, renderedMessageIds, summaryCoverage, uncoveredMessageIds, valid } };
}
function requireVerifiedCapture(captured: Awaited<ReturnType<SessionCapture["captureTranscript"]>>): asserts captured is NonNullable<typeof captured> {
  if (!captured?.verification?.verified || !captured.verification.complete || !captured.verification.boundaryFound)
    throw new ShadowStoreError("Capture boundary is unverified", HTTP.unprocessable);
}

const MAX_WINDOW_BYTES = 65_536;
function indexOriginals(raw: string, scrubber: ScrubEngine, boundaryUuid: string) {
  const index = new Map<string, { uuid?: string; origin: ShadowOriginal["origin"] }[]>();
  let lastUuid: string | undefined;
  for (const line of raw.split("\n").filter(line => line.trim())) {
    const row = JSON.parse(line);
    const parsed = parseClaudeTranscriptRecord(line).message;
    if (!parsed) continue;
    if (row.uuid !== undefined) correlationId(row.uuid, scrubber);
    lastUuid = row.uuid;
    const key = JSON.stringify([parsed.role, normalizeMessageContent(scrubber.scrub(parsed.content))]);
    const origin = sourceOrigin(row, parsed.role);
    index.set(key, [...(index.get(key) ?? []), { uuid: row.uuid, origin }]);
  }
  if (lastUuid !== boundaryUuid) throw new ShadowStoreError("Source has model-visible content after the cut", HTTP.unprocessable);
  return index;
}
type SourceMetadata = { type?: string; isMeta?: boolean; isCompactSummary?: boolean };
function sourceOrigin(row: SourceMetadata, role: string): ShadowOriginal["origin"] {
  if (row.type !== "user" || role !== "user") return "other";
  return row.isMeta || row.isCompactSummary ? "other" : "user";
}

function originalsFromRecords(records: Awaited<ReturnType<SessionCapture["conversationStore"]["getMessages"]>>, index: ReturnType<typeof indexOriginals>): ShadowOriginal[] {
  return records.map(row => {
    const matches = index.get(JSON.stringify([row.role, row.content])) ?? [];
    const matched = matches.length === 1 ? matches[0] : undefined;
    return { id: row.messageId, seq: row.seq, role: row.role, text: row.content, origin: matched?.origin ?? unanimousOrigin(matches), ...(matched?.uuid ? { uuid: matched.uuid } : {}) };
  });

}
function unanimousOrigin(matches: { origin: ShadowOriginal["origin"] }[]): ShadowOriginal["origin"] {
  const first = matches[0];
  return first && matches.every(match => match.origin === first.origin) ? first.origin : "unknown";
}
