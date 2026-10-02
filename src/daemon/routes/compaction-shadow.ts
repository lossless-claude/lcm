import { randomUUID } from "node:crypto";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { ScrubEngine } from "../../scrub.js";
import { corpusConfigPath, isExcluded, readCorpusConfig } from "../../eval/corpus-policy.js";
import { projectDir, projectId } from "../project.js";
import { validateCwd } from "../validate-cwd.js";
import { sendJson, type RouteHandler } from "../server.js";
import { captureShadowSnapshot } from "../shadow/snapshot.js";
import { CompactionShadowStore, ShadowStoreError } from "../shadow/store.js";
import { SHADOW_RETENTION_MS, HEADER_SECTIONS, digest, hash, object, objectHash, safeId, nonnegative, validHeader, validUsage,
  type ArmRecord, type NativeRecord, type ShadowManifest, type ShadowMessage, type ShadowHeader, type ShadowUsage } from "../shadow/types.js";

const OUTCOMES = new Set(["answered", "skipped", "nothing-to-fork", "api-error", "empty-reply", "aborted", "invalid-output", "unavailable", "spend-cap", "unconfirmed"]);
function messages(value: unknown, scrubber: ScrubEngine): ShadowMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !object(row) || !["user", "assistant"].includes(String(row.role)) || typeof row.text !== "string" || row.handle !== undefined && typeof row.handle !== "string"))
    throw new ShadowStoreError("Invalid engine messages", 400);
  return value.map(row => ({ role: row.role, text: scrubber.scrub(row.text), ...(row.handle !== undefined ? { handle: row.handle } : {}) }));
}
function header(value: unknown, scrubber: ScrubEngine): ShadowHeader | null {
  if (value === undefined || value === null) return null;
  if (!validHeader(value)) throw new ShadowStoreError("Invalid header", 400);
  const result = { version: 1 } as ShadowHeader;
  for (const key of HEADER_SECTIONS) result[key] = value[key].map(item => ({
    text: scrubber.scrub(item.text), sources: item.sources.map(source => typeof source === "string" ? scrubber.scrub(source) : { quote: scrubber.scrub(source.quote) }),
    ...(typeof item.status === "string" ? { status: scrubber.scrub(item.status) } : {}),
    ...(typeof item.fix === "string" ? { fix: scrubber.scrub(item.fix) } : {}),
    ...(Array.isArray(item.supersedes) && item.supersedes.every(id => typeof id === "string") ? { supersedes: item.supersedes.map(id => scrubber.scrub(id)) } : {}),
  }));
  return result;
}
function usage(value: unknown): ShadowUsage | null {
  if (value === undefined || value === null) return null;
  if (!validUsage(value)) throw new ShadowStoreError("Invalid usage", 400);
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = value;
  return { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens };
}
function measurement(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!nonnegative(value)) throw new ShadowStoreError("Invalid measurement", 400);
  return value;
}
function basicRecord(record: Record<string, unknown>, scrubber: ScrubEngine) {
  if (typeof record.text !== "string" || !OUTCOMES.has(String(record.outcome))) throw new ShadowStoreError("Invalid record", 400);
  return { text: scrubber.scrub(record.text), outcome: String(record.outcome), usage: usage(record.usage), durationMs: measurement(record.durationMs), costUsd: measurement(record.costUsd) };
}
function nativeRecord(record: Record<string, unknown>, scrubber: ScrubEngine): NativeRecord {
  const base = basicRecord(record, scrubber);
  if (record.summaryUuid !== undefined && !safeId(record.summaryUuid)) throw new ShadowStoreError("Invalid summary uuid", 400);
  return { ...base, tail: messages(record.tail, scrubber), rawTextHash: digest(record.text as string), rawTextBytes: Buffer.byteLength(record.text as string, "utf8"),
    ...(record.summaryUuid ? { summaryUuid: record.summaryUuid as string } : {}),
    ...(record.tokensBefore !== undefined ? { tokensBefore: measurement(record.tokensBefore)! } : {}),
    ...(record.tokensAfter !== undefined ? { tokensAfter: measurement(record.tokensAfter)! } : {}),
    ...(record.hookAddedMs !== undefined ? { hookAddedMs: measurement(record.hookAddedMs)! } : {}),
  };
}
function armRecord(input: Record<string, unknown>, record: Record<string, unknown>, scrubber: ScrubEngine): ArmRecord {
  if (!["A", "B", "C"].includes(String(input.arm)) || !safeId(input.attempt_id) || typeof record.requestedModel !== "string" || !record.requestedModel || !hash(record.inputHash) || !hash(record.promptHash))
    throw new ShadowStoreError("Invalid arm identity", 400);
  const attempts = record.usageAttempts ?? [];
  if (!Array.isArray(attempts) || attempts.some(attempt => !object(attempt) || !validUsage(attempt.usage) || typeof attempt.failed !== "boolean" || typeof attempt.model !== "string"))
    throw new ShadowStoreError("Invalid usage attempts", 400);
  return { ...basicRecord(record, scrubber), arm: input.arm as ArmRecord["arm"], attemptId: input.attempt_id,
    requestedModel: scrubber.scrub(record.requestedModel), inputHash: record.inputHash, promptHash: record.promptHash, header: header(record.header, scrubber),
    usageAttempts: attempts.map(attempt => ({ usage: usage(attempt.usage)!, failed: attempt.failed, model: scrubber.scrub(attempt.model) })),
  };
}

/** Benchmark policy is optional for capture, mandatory only for offline evaluation. */
function excluded(cwd: string, paths: LcmPaths): boolean {
  try { return isExcluded(cwd, readCorpusConfig(corpusConfigPath(paths), paths, { candidateCwds: [cwd] }).exclude); }
  catch { return false; }
}
export function createCompactionShadowHandlers(config: DaemonConfig, paths: LcmPaths): Record<"start" | "native" | "arm", RouteHandler> {
  const store = new CompactionShadowStore(paths);
  store.recover();
  const handle = (kind: "start" | "native" | "arm"): RouteHandler => async (_req, res, body) => {
    try {
      const input: unknown = JSON.parse(body);
      if (!object(input) || typeof input.cwd !== "string" || !safeId(input.session_id) || !safeId(input.cut_id ?? "generated")) throw new ShadowStoreError("Invalid cut identity", 400);
      const cwd = validateCwd(input.cwd);
      if (kind === "start" && excluded(cwd, paths)) { sendJson(res, 200, { admitted: false, reason: "excluded" }); return; }
      const scrubber = await ScrubEngine.forProject(config.security.sensitivePatterns, projectDir(cwd, paths));
      if (kind !== "start") {
        if (!safeId(input.cut_id) || !hash(input.snapshot_hash) || !object(input.record)) throw new ShadowStoreError("Invalid result binding", 400);
        const cut = store.bind(cwd, input.cut_id, input.session_id, input.snapshot_hash);
        if (kind === "native") store.writeNative(cut, nativeRecord(input.record, scrubber));
        else store.writeArm(cut, armRecord(input, input.record, scrubber));
        sendJson(res, 200, { stored: true }); return;
      }
      if (!safeId(input.boundary_uuid) || typeof input.model !== "string" || !input.model.trim() || !["manual", "auto", "plugin"].includes(String(input.trigger)) ||
          input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 50_000) ||
          input.transcript_path !== undefined && typeof input.transcript_path !== "string") throw new ShadowStoreError("Invalid snapshot request", 400);
      const cutId = input.cut_id as string | undefined ?? randomUUID();
      store.recoverProject(cwd);
      const prior = store.read(cwd, cutId);
      const instructions = scrubber.scrub(input.instructions as string ?? "");
      if (prior) {
        if (prior.cut.sessionId !== input.session_id || prior.cut.boundaryUuid !== input.boundary_uuid || prior.cut.model !== input.model || prior.cut.trigger !== input.trigger || prior.cut.instructions !== instructions)
          throw new ShadowStoreError("Cut request conflicts with its identity");
        sendJson(res, 200, { admitted: true, ...prior }); return;
      }
      const { snapshot, conversationId } = await captureShadowSnapshot(paths, scrubber, { cwd, sessionId: input.session_id, boundaryUuid: input.boundary_uuid, transcriptPath: input.transcript_path as string | undefined });
      snapshot.engineMessages = messages(input.engine_messages, scrubber);
      const cut: ShadowManifest = { version: 1, cutId, cwd, projectId: projectId(cwd), sessionId: input.session_id, conversationId,
        boundaryUuid: input.boundary_uuid, model: scrubber.scrub(input.model), trigger: input.trigger as ShadowManifest["trigger"], instructions,
        snapshotHash: objectHash(snapshot), rulesKey: scrubber.rulesKey, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SHADOW_RETENTION_MS).toISOString(),
        state: "pending", owner: store.owner, expectedArms: ["A", "B", "C"] };
      const concurrent = store.read(cwd, cutId);
      if (concurrent) {
        const same = concurrent.cut.snapshotHash === cut.snapshotHash && concurrent.cut.sessionId === cut.sessionId &&
          concurrent.cut.model === cut.model && concurrent.cut.trigger === cut.trigger && concurrent.cut.instructions === cut.instructions;
        if (!same) throw new ShadowStoreError("Concurrent cut request conflicts with its identity");
        sendJson(res, 200, { admitted: true, ...concurrent }); return;
      }
      store.create(cut, snapshot); sendJson(res, 200, { admitted: true, cut, snapshot });
    } catch (error) {
      const status = error instanceof ShadowStoreError ? error.status : error instanceof SyntaxError ? 400 : 422;
      sendJson(res, status, { error: error instanceof ShadowStoreError ? error.message : "Shadow request could not be verified" });
    }
  };
  return { start: handle("start"), native: handle("native"), arm: handle("arm") };
}
