import { HEADER_SECTIONS, hash, safeId, validHeader, validModelName, type ArmRecord, type HeaderItem, type NativeRecord, type ShadowOriginal } from "../../daemon/shadow/types.js";
import type { EvaluationCut } from "./reader.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST_LENGTH = 64;
export const validUuid = (value: unknown): value is string => typeof value === "string" && UUID.exec(value)?.[0] === value;
const exactSafeId = (value: unknown): value is string => safeId(value) && value.trim() === value;
const summaryId = (value: unknown): boolean => exactSafeId(value) && value.startsWith("sum_") && value.length > "sum_".length;
const positiveId = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
const exactHash = (value: unknown): boolean => hash(value) && value.length === DIGEST_LENGTH;

export function requireIdentifier(value: unknown, shape: (value: unknown) => boolean): void {
  if (!shape(value)) throw new Error("Malformed source identifier");
}
export function validateCutIdentifiers(cut: EvaluationCut): void {
  requireIdentifier(cut.projectId, exactHash); requireIdentifier(cut.cutId, exactSafeId);
  requireIdentifier(cut.sessionId, validUuid); requireIdentifier(cut.boundaryUuid, validUuid);
  requireIdentifier(cut.sourceHash, exactHash);
  if (cut.snapshotHash !== null) requireIdentifier(cut.snapshotHash, exactHash);
  cut.originals.forEach(validateOriginal);
  for (const summary of cut.summaryCoverage) {
    requireIdentifier(summary.summaryId, summaryId);
    summary.messageIds.forEach(id => requireIdentifier(id, positiveId));
  }
  if (cut.native) validateNative(cut.native);
  cut.arms.forEach(validateArm);
}
function validateOriginal(row: ShadowOriginal): void {
  requireIdentifier(row.id, positiveId);
  if (row.uuid !== undefined) requireIdentifier(row.uuid, validUuid);
}
function validateNative(record: NativeRecord): void {
  if (record.summaryUuid !== undefined) requireIdentifier(record.summaryUuid, validUuid);
  requireIdentifier(record.rawTextHash, exactHash); requireIdentifier(record.outcome, exactSafeId);
  for (const row of record.tail) if (row.handle !== undefined) requireIdentifier(row.handle, exactSafeId);
}
function validateArm(record: ArmRecord): void {
  requireIdentifier(record.arm, value => ["A", "B", "C"].includes(value as string));
  requireIdentifier(record.attemptId, exactSafeId); requireIdentifier(record.requestedModel, validModelName);
  requireIdentifier(record.inputHash, exactHash); requireIdentifier(record.promptHash, exactHash);
  requireIdentifier(record.outcome, exactSafeId);
  record.usageAttempts.forEach(attempt => requireIdentifier(attempt.model, validModelName));
  if (record.errorKind !== undefined) requireIdentifier(record.errorKind, value => typeof value === "string" && /^[a-z_]{1,80}$/.exec(value)?.[0] === value);
  if (record.options?.effort !== undefined) requireIdentifier(record.options.effort, value => ["low", "medium", "high", "xhigh", "max"].includes(value as string));
  if (validHeader(record.header)) HEADER_SECTIONS.flatMap(key => record.header![key]).forEach(validateHeaderItem);
}
function validateHeaderItem(item: HeaderItem): void {
  item.sources.forEach(source => { if (typeof source === "string") requireIdentifier(source, sourcePointer); });
  if (item.supersedes !== undefined) item.supersedes.forEach(id => requireIdentifier(id, exactSafeId));
}
function sourcePointer(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const raw = /^\[raw:([A-Za-z0-9_-]+):(\d+)\]$/.exec(value);
  if (raw) return raw[0] === value && exactSafeId(raw[1]) && positiveId(Number(raw[2]));
  const summary = /^\[sum:(sum_[A-Za-z0-9_-]+)\]$/.exec(value);
  return Boolean(summary && summary[0] === value && summaryId(summary[1]));
}
