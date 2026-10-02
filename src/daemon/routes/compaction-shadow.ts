import { randomUUID } from "node:crypto";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { ScrubEngine } from "../../scrub.js";
import { corpusConfigPath, isExcluded, readCorpusConfig } from "../../eval/corpus-policy.js";
import { projectDir, projectId } from "../project.js";
import { validateCwd } from "../validate-cwd.js";
import { sendJson, type RouteHandler } from "../server.js";
import { shadowMessages, nativeRecord, armRecord } from "../shadow/records.js";
import { captureShadowSnapshot } from "../shadow/snapshot.js";
import { CompactionShadowStore, ShadowStoreError, recoverShadowProject, recoverShadowProjects } from "../shadow/store.js";
import { SHADOW_RETENTION_MS, HTTP, hash, object, objectHash, safeId, type ShadowManifest } from "../shadow/types.js";

/** Benchmark policy is optional for capture, mandatory only for offline evaluation. */
function excluded(cwd: string, paths: LcmPaths): boolean {
  try { return isExcluded(cwd, readCorpusConfig(corpusConfigPath(paths), paths, { candidateCwds: [cwd] }).exclude); }
  catch { return false; }
}
export function createCompactionShadowHandlers(config: DaemonConfig, paths: LcmPaths): Record<"start" | "native" | "arm", RouteHandler> {
  const store = new CompactionShadowStore(paths);
  recoverShadowProjects(store, paths);
  const handle = (kind: "start" | "native" | "arm"): RouteHandler => async (_req, res, body) => {
    try {
      const input: unknown = JSON.parse(body);
      validateIdentity(input);
      const cwd = validateCwd(input.cwd);
      if (kind === "start" && excluded(cwd, paths)) { sendJson(res, HTTP.ok, { admitted: false, reason: "excluded" }); return; }
      const scrubber = await ScrubEngine.forProject(config.security.sensitivePatterns, projectDir(cwd, paths));
      if (kind !== "start") {
        storeResult({ store, cwd, scrubber }, input, kind);
        sendJson(res, HTTP.ok, { stored: true }); return;
      }
      sendJson(res, HTTP.ok, await admitCut({ paths, store, cwd, scrubber }, input));
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
  const instructions = scrubber.scrub(input.instructions as string ?? "");
  if (prior) {
    if (identityHash(prior.cut) !== identityHash({ sessionId: input.session_id, boundaryUuid: input.boundary_uuid, model: input.model, trigger: input.trigger, instructions }))
      throw new ShadowStoreError("Cut request conflicts with its identity");
    return { admitted: true, ...prior };
  }
  const { snapshot, conversationId } = await captureShadowSnapshot(paths, scrubber, { cwd, sessionId: input.session_id as string, boundaryUuid: input.boundary_uuid as string, transcriptPath: input.transcript_path as string | undefined });
  snapshot.engineMessages = shadowMessages(input.engine_messages, scrubber);
  const cut: ShadowManifest = { version: 1, cutId, cwd, projectId: projectId(cwd), sessionId: input.session_id as string, conversationId,
    boundaryUuid: input.boundary_uuid as string, model: scrubber.scrub(input.model as string), trigger: input.trigger as ShadowManifest["trigger"], instructions,
    snapshotHash: objectHash(snapshot), rulesKey: scrubber.rulesKey, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SHADOW_RETENTION_MS).toISOString(),
    state: "pending", owner: store.owner, expectedArms: ["A", "B", "C"] };
  const concurrent = store.read(cwd, cutId);
  if (concurrent) {
    const same = concurrent.cut.snapshotHash === cut.snapshotHash && identityHash(concurrent.cut) === identityHash(cut);
    if (!same) throw new ShadowStoreError("Concurrent cut request conflicts with its identity");
    return { admitted: true, ...concurrent };
  }
  store.create(cut, snapshot); return { admitted: true, cut, snapshot };
}
function validateSnapshotInput(input: Record<string, unknown>): void {
  if (!safeId(input.boundary_uuid)) throw new ShadowStoreError("Invalid source boundary", HTTP.badRequest);
  if (typeof input.model !== "string" || !input.model.trim()) throw new ShadowStoreError("Invalid model", HTTP.badRequest);
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
}
function storeResult({ store, cwd, scrubber }: Pick<Admission, "store" | "cwd" | "scrubber">, input: Record<string, unknown>, kind: "native" | "arm"): void {
  if (!safeId(input.cut_id) || !hash(input.snapshot_hash)) throw new ShadowStoreError("Invalid result binding", HTTP.badRequest);
  if (!object(input.record)) throw new ShadowStoreError("Invalid result record", HTTP.badRequest);
  const cut = store.bind(cwd, input.cut_id, { sessionId: input.session_id as string, snapshotHash: input.snapshot_hash });
  if (kind === "native") store.writeNative(cut, nativeRecord(input.record, scrubber));
  else store.writeArm(cut, armRecord(input, input.record, scrubber));
}
function identityHash(cut: { sessionId?: unknown; boundaryUuid?: unknown; model?: unknown; trigger?: unknown; instructions?: unknown }): string {
  return objectHash([cut.sessionId, cut.boundaryUuid, cut.model, cut.trigger, cut.instructions]);
}
