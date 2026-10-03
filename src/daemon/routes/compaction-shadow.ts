import { randomUUID } from "node:crypto";
import type { DaemonConfig } from "../config.js";
import { noopDaemonLog, type DaemonLog } from "../log.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { ScrubEngine } from "../../scrub.js";
import { corpusConfigPath, isExcluded, readCorpusConfig } from "../../eval/corpus-policy.js";
import { projectDir, projectId } from "../project.js";
import { validateCwd } from "../validate-cwd.js";
import { sendJson, type RouteHandler } from "../server.js";
import { shadowMessages, nativeRecord, armRecord, correlationId } from "../shadow/records.js";
import { captureShadowSnapshot } from "../shadow/snapshot.js";
import { verifyNativeTail } from "../shadow/tail.js";
import { headerCitationEvidence, prepareHeaderJob, renderCompactionDocument } from "../shadow/header-job.js";
import { resolveHeaderCitations } from "../../../hooks/header-citations.js";
import { CompactionShadowStore, ShadowStoreError, recoverShadowProject, recoverShadowProjects } from "../shadow/store.js";
import { SHADOW_RETENTION_MS, HTTP, hash, object, objectHash, safeId, validModelName, type ShadowManifest, type ShadowSnapshot, type ShadowMessage } from "../shadow/types.js";

/** A missing benchmark policy permits admission; an unreadable or invalid policy refuses it. */
function policyRefusal(cwd: string, paths: LcmPaths, log: DaemonLog): "excluded" | "policy-unavailable" | undefined {
  try {
    const config = readCorpusConfig(corpusConfigPath(paths), paths, { candidateCwds: [cwd] });
    return isExcluded(cwd, config.exclude) ? "excluded" : undefined;
  } catch (err) {
    log.write("warn", "compaction-shadow.policy_unavailable", { cwd, err });
    return "policy-unavailable";
  }
}
export function createCompactionShadowHandlers(config: DaemonConfig, paths: LcmPaths, log: DaemonLog = noopDaemonLog): Record<"start" | "native" | "arm", RouteHandler> {
  const store = new CompactionShadowStore(paths);
  recoverShadowProjects(store, paths);
  const handle = (kind: "start" | "native" | "arm"): RouteHandler => async (_req, res, body) => {
    try {
      const input: unknown = JSON.parse(body);
      validateIdentity(input);
      const cwd = validateCwd(input.cwd);
      if (kind === "start") {
        const reason = policyRefusal(cwd, paths, log);
        if (reason) { sendJson(res, HTTP.ok, { admitted: false, reason }); return; }
      }
      const scrubber = await ScrubEngine.forProject(config.security.sensitivePatterns, projectDir(cwd, paths));
      for (const id of [input.session_id, input.cut_id, input.boundary_uuid].filter(id => id !== undefined)) correlationId(id, scrubber);
      if (kind !== "start") {
        const job = storeResult({ store, cwd, scrubber }, input, kind);
        sendJson(res, HTTP.ok, { stored: true, ...(input.prepare_header === true ? { job } : {}) }); return;
      }
      const admitted = await admitCut({ paths, store, cwd, scrubber }, input);
      const job = input.prepare_header === true ? cutHeaderJob(admitted, [], scrubber) : undefined;
      sendJson(res, HTTP.ok, { ...admitted, ...(job ? { job } : {}) });
    } catch (error) {
      const status = error instanceof ShadowStoreError ? error.status : error instanceof SyntaxError ? HTTP.badRequest : HTTP.unprocessable;
      sendJson(res, status, { error: error instanceof ShadowStoreError ? error.message : "Shadow request could not be verified" });
    }
  };
  return { start: handle("start"), native: handle("native"), arm: handle("arm") };
}

const MAX_INSTRUCTIONS_LENGTH = 50_000;
type Admission = { paths: LcmPaths; store: CompactionShadowStore; cwd: string; scrubber: ScrubEngine };
async function admitCut({ paths, store, cwd, scrubber }: Admission, input: Record<string, unknown>) {
  validateSnapshotInput(input);
  const cutId = input.cut_id as string | undefined ?? randomUUID();
  recoverShadowProject(store, cwd);
  const prior = store.read(cwd, cutId);
  const requestHash = requestIdentityHash(input, cutId);
  const engineMessages = shadowMessages(input.engine_messages, scrubber);
  const instructions = scrubber.scrub(input.instructions as string ?? "");
  const model = input.model as string;
  if (prior) {
    if (prior.cut.requestIdentityHash !== requestHash)
      throw new ShadowStoreError("Cut request conflicts with its identity");
    return { admitted: true, ...prior };
  }
  const { snapshot, conversationId } = await captureShadowSnapshot(paths, scrubber, { cwd, sessionId: input.session_id as string, boundaryUuid: input.boundary_uuid as string, transcriptPath: input.transcript_path as string | undefined });
  snapshot.engineMessages = engineMessages;
  const cut: ShadowManifest = { version: 1, cutId, cwd, projectId: projectId(cwd), sessionId: input.session_id as string, conversationId,
    boundaryUuid: input.boundary_uuid as string, model, trigger: input.trigger as ShadowManifest["trigger"], instructions, requestIdentityHash: requestHash,
    snapshotHash: objectHash(snapshot), rulesKey: scrubber.rulesKey, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SHADOW_RETENTION_MS).toISOString(),
    state: "pending", owner: store.owner, expectedArms: ["A", "B", "C"] };
  const concurrent = store.read(cwd, cutId);
  if (concurrent) {
    const same = concurrent.cut.snapshotHash === cut.snapshotHash && concurrent.cut.requestIdentityHash === requestHash;
    if (!same) throw new ShadowStoreError("Concurrent cut request conflicts with its identity");
    return { admitted: true, ...concurrent };
  }
  store.create(cut, snapshot); return { admitted: true, cut, snapshot };
}
function validateSnapshotInput(input: Record<string, unknown>): void {
  if (!safeId(input.boundary_uuid)) throw new ShadowStoreError("Invalid source boundary", HTTP.badRequest);
  if (!validModelName(input.model)) throw new ShadowStoreError("Invalid model", HTTP.badRequest);
  if (typeof input.trigger !== "string" || !["manual", "auto", "plugin"].includes(input.trigger)) throw new ShadowStoreError("Invalid trigger", HTTP.badRequest);
  validateOptionalText(input.instructions, MAX_INSTRUCTIONS_LENGTH);
  validateOptionalText(input.transcript_path);
}
function validateOptionalText(value: unknown, limit = Infinity): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > limit) throw new ShadowStoreError("Invalid snapshot text", HTTP.badRequest);
}

function validateIdentity(input: unknown): asserts input is Record<string, unknown> & { cwd: string; session_id: string } {
  if (!object(input) || typeof input.cwd !== "string") throw new ShadowStoreError("Invalid project identity", HTTP.badRequest);
  if (!safeId(input.session_id)) throw new ShadowStoreError("Invalid session identity", HTTP.badRequest);
  if (!safeId(input.cut_id ?? "generated")) throw new ShadowStoreError("Invalid cut identity", HTTP.badRequest);
  if (input.prepare_header !== undefined && typeof input.prepare_header !== "boolean") throw new ShadowStoreError("Invalid job request", HTTP.badRequest);
}
function storeResult({ store, cwd, scrubber }: Pick<Admission, "store" | "cwd" | "scrubber">, input: Record<string, unknown>, kind: "native" | "arm") {
  if (!safeId(input.cut_id) || !hash(input.snapshot_hash)) throw new ShadowStoreError("Invalid result binding", HTTP.badRequest);
  if (!object(input.record)) throw new ShadowStoreError("Invalid result record", HTTP.badRequest);
  const { cut, snapshot } = store.bind(cwd, input.cut_id, { sessionId: input.session_id as string, snapshotHash: input.snapshot_hash });
  const context = { store, scrubber, cut, snapshot };
  return kind === "native" ? publishNative(context, input.record, input.prepare_header === true) : publishArm(context, input);
}
type BoundCut = { store: CompactionShadowStore; scrubber: ScrubEngine; cut: ShadowManifest; snapshot: ShadowSnapshot };
function publishNative(context: BoundCut, input: Record<string, unknown>, prepare: boolean) {
  const { store, scrubber, cut, snapshot } = context, record = nativeRecord(input, scrubber);
  verifyNativeTail(record.tail, snapshot.engineMessages, text => scrubber.scrub(text));
  store.writeNative(cut, record);
  return prepare && nativeVerified(record) ? cutHeaderJob(context, record.tail, scrubber) : null;
}
function publishArm(context: BoundCut, input: Record<string, unknown>) {
  const { store, scrubber, cut, snapshot } = context, record = armRecord(input, input.record as Record<string, unknown>, scrubber);
  if (record.header?.version === 2) record.citations = resolveHeaderCitations(record.header, headerCitationEvidence(cut.cutId,
    snapshot.originals.map(row => ({ ...row, text: scrubber.scrub(row.text) })), snapshot.window.items ?? []));
  const native = store.readNative(cut);
  if (record.header?.version === 2 && native && nativeVerified(native)) record.document = renderCompactionDocument(cutHeaderJob(context, native.tail, scrubber), record.header);
  store.writeArm(cut, record); return null;
}
function nativeVerified(record: import("../shadow/types.js").NativeRecord): boolean {
  return record.outcome === "answered" && (record.fidelity === undefined || record.fidelity === "verified");
}
function cutHeaderJob({ cut, snapshot }: { cut: ShadowManifest; snapshot: ShadowSnapshot }, tail: ShadowMessage[], scrubber: ScrubEngine) {
  if (!snapshot.window.items) throw new ShadowStoreError("Structured header input is unavailable", HTTP.unprocessable);
  return prepareHeaderJob({ cutId: cut.cutId, instructions: scrubber.scrub(cut.instructions),
    originals: snapshot.originals.map(row => ({ ...row, text: scrubber.scrub(row.text) })), window: snapshot.window.items.map(row => ({ ...row, content: scrubber.scrub(row.content) })),
    engineMessages: snapshot.engineMessages.map(row => ({ ...row, text: scrubber.scrub(row.text) })), tail: tail.map(row => ({ ...row, text: scrubber.scrub(row.text) })) });
}
function requestIdentityHash(input: Record<string, unknown>, cutId: string): string {
  return objectHash([input.cwd, cutId, input.session_id, input.boundary_uuid, input.model, input.trigger, input.instructions, engineMessagesHash(input.engine_messages)]);
}
function engineMessagesHash(value: unknown): string {
  if (value === undefined) return objectHash([]);
  if (!Array.isArray(value)) throw new ShadowStoreError("Invalid engine messages", HTTP.badRequest);
  return objectHash(value.map(row => {
    if (!object(row)) throw new ShadowStoreError("Invalid engine message", HTTP.badRequest);
    return [row.role, row.text, row.handle];
  }));
}
