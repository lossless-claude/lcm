import { ScrubEngine } from "../../scrub.js";
import { compactionHeaderItems, validCompactionHeader, mapCompactionHeaderText, type CompactionHeader } from "../../../hooks/compaction-header-schema.js";
import { ShadowStoreError } from "./store.js";
import { HTTP, HEADER_SECTIONS, digest, hash, object, safeId, nonnegative, validHeader, validUsage, validModelName,
  type ArmRecord, type NativeRecord, type ShadowMessage, type ShadowHeader, type StoredShadowHeader, type ShadowUsage } from "./types.js";

const OUTCOMES = new Set(["answered", "skipped", "nothing-to-fork", "api-error", "empty-reply", "aborted", "invalid-output", "unavailable", "spend-cap", "unconfirmed"]);
/** Correlation ids are preserved exactly or refused; redaction would change their identity. */
export function correlationId(value: unknown, scrubber: ScrubEngine): string {
  if (!safeId(value) || scrubber.scrub(value) !== value) throw new ShadowStoreError("Invalid shadow identifier", HTTP.badRequest);
  return value;
}
function validEngineMessage(row: unknown): boolean {
  if (!object(row)) return false;
  if (typeof row.role !== "string" || !["user", "assistant"].includes(row.role)) return false;
  if (typeof row.text !== "string") return false;
  return row.handle === undefined || safeId(row.handle);
}
export function shadowMessages(value: unknown, scrubber: ScrubEngine): ShadowMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !validEngineMessage(row)))
    throw new ShadowStoreError("Invalid engine messages", HTTP.badRequest);
  return value.map(row => ({ role: row.role, text: scrubber.scrub(row.text), ...(row.handle !== undefined ? { handle: correlationId(row.handle, scrubber) } : {}) }));
}
function sourcePointer(value: string | { quote: string }, scrubber: ScrubEngine): string | { quote: string } {
  if (typeof value !== "string") return { quote: scrubber.scrub(value.quote) };
  const raw = /^\[raw:([A-Za-z0-9_-]+):(\d+)\]$/.exec(value);
  const summary = /^\[sum:(sum_[A-Za-z0-9_-]+)\]$/.exec(value);
  const excerpt = /^\[excerpt:([A-Za-z0-9_-]+)\]$/.exec(value);
  const id = raw?.[1] ?? summary?.[1] ?? excerpt?.[1];
  if (!id) throw new ShadowStoreError("Invalid source pointer", HTTP.badRequest);
  correlationId(id, scrubber);
  if (raw && (!Number.isSafeInteger(Number(raw[2])) || Number(raw[2]) <= 0)) throw new ShadowStoreError("Invalid raw source id", HTTP.badRequest);
  return value;
}
function supersessions(value: unknown, scrubber: ScrubEngine): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ShadowStoreError("Invalid supersessions", HTTP.badRequest);
  return value.map(id => correlationId(id, scrubber));
}
function header(value: unknown, scrubber: ScrubEngine): StoredShadowHeader | null {
  if (value === undefined || value === null) return null;
  if (validCompactionHeader(value)) return scrubWorkingHeader(value, scrubber);
  if (!validHeader(value)) throw new ShadowStoreError("Invalid header", HTTP.badRequest);
  const result = { version: 1 } as ShadowHeader;
  for (const key of HEADER_SECTIONS) result[key] = value[key].map(item => ({
    text: scrubber.scrub(item.text), sources: item.sources.map(source => sourcePointer(source, scrubber)),
    ...(typeof item.status === "string" ? { status: scrubber.scrub(item.status) } : {}),
    ...(typeof item.fix === "string" ? { fix: scrubber.scrub(item.fix) } : {}),
    ...(item.supersedes !== undefined ? { supersedes: supersessions(item.supersedes, scrubber) } : {}),
  }));
  return result;
}
function scrubWorkingHeader(value: CompactionHeader, scrubber: ScrubEngine): CompactionHeader {
  const pointers = compactionHeaderItems(value).flatMap(item => [...item.sources, ...("supersedes" in item ? item.supersedes ?? [] : [])]);
  pointers.filter((pointer): pointer is string => typeof pointer === "string").forEach(pointer => sourcePointer(pointer, scrubber));
  return mapCompactionHeaderText(value, text => scrubber.scrub(text));
}
function usage(value: unknown): ShadowUsage | null {
  if (value === undefined || value === null) return null;
  if (!validUsage(value)) throw new ShadowStoreError("Invalid usage", HTTP.badRequest);
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = value;
  return { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens };
}
function measurement(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!nonnegative(value)) throw new ShadowStoreError("Invalid measurement", HTTP.badRequest);
  return value;
}
function basicRecord(record: Record<string, unknown>, scrubber: ScrubEngine) {
  if (typeof record.text !== "string" || typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome)) throw new ShadowStoreError("Invalid record", HTTP.badRequest);
  return { text: scrubber.scrub(record.text), outcome: String(record.outcome), usage: usage(record.usage), durationMs: measurement(record.durationMs), costUsd: measurement(record.costUsd) };
}
export function nativeRecord(record: Record<string, unknown>, scrubber: ScrubEngine): NativeRecord {
  const base = basicRecord(record, scrubber);
  if (record.summaryUuid !== undefined) correlationId(record.summaryUuid, scrubber);
  return { ...base, ...nativeExtraction(record, scrubber), tail: shadowMessages(record.tail, scrubber), rawTextHash: digest(record.text as string), rawTextBytes: Buffer.byteLength(record.text as string, "utf8"),
    ...(record.summaryUuid ? { summaryUuid: record.summaryUuid as string } : {}),
    ...(record.tokensBefore !== undefined ? { tokensBefore: measurement(record.tokensBefore)! } : {}),
    ...(record.tokensAfter !== undefined ? { tokensAfter: measurement(record.tokensAfter)! } : {}),
    ...(record.hookAddedMs !== undefined ? { hookAddedMs: measurement(record.hookAddedMs)! } : {}),
  };
}
function nativeExtraction(record: Record<string, unknown>, scrubber: ScrubEngine): Pick<NativeRecord, "fidelity" | "observedMessages" | "candidateIndices"> {
  if (record.fidelity === undefined) return {};
  if (!["verified", "native-summary-unverified", "native-tail-unverified", "skipped", "aborted", "unavailable"].includes(record.fidelity as string)) throw new ShadowStoreError("Invalid native fidelity", HTTP.badRequest);
  const candidateIndices = record.candidateIndices ?? [];
  if (!Array.isArray(candidateIndices) || candidateIndices.some(value => !Number.isSafeInteger(value) || value < 0)) throw new ShadowStoreError("Invalid native candidates", HTTP.badRequest);
  return { fidelity: record.fidelity as NativeRecord["fidelity"], candidateIndices, observedMessages: shadowMessages(record.observedMessages, scrubber) };
}
export function armRecord(input: Record<string, unknown>, record: Record<string, unknown>, scrubber: ScrubEngine): ArmRecord {
  validateArmIdentity(input, record);
  correlationId(input.attempt_id, scrubber);
  for (const value of [record.inputHash, record.promptHash]) if (value !== null) correlationId(value, scrubber);
  const attempts = usageAttempts(record.usageAttempts);
  const options = completionOptions(record.options);
  const classification = failureClassification(record, scrubber);
  return { ...basicRecord(record, scrubber), arm: input.arm as ArmRecord["arm"], attemptId: input.attempt_id as string,
    requestedModel: record.requestedModel as string, inputHash: record.inputHash as string | null, promptHash: record.promptHash as string | null, header: header(record.header, scrubber),
    usageAttempts: attempts, ...classification, ...(options ? { options } : {}),
  };
}


function validateArmIdentity(input: Record<string, unknown>, record: Record<string, unknown>): void {
  if (typeof input.arm !== "string" || !["A", "B", "C"].includes(input.arm)) throw new ShadowStoreError("Invalid arm", HTTP.badRequest);
  if (!safeId(input.attempt_id)) throw new ShadowStoreError("Invalid attempt", HTTP.badRequest);
  if (!validModelName(record.requestedModel)) throw new ShadowStoreError("Invalid model", HTTP.badRequest);
  validatePromptHashes(record);
}
function usageAttempts(value: unknown): ArmRecord["usageAttempts"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ShadowStoreError("Invalid usage attempts", HTTP.badRequest);
  return value.map(attempt => {
    if (!object(attempt)) throw new ShadowStoreError("Invalid usage attempt", HTTP.badRequest);
    if (typeof attempt.failed !== "boolean" || !validModelName(attempt.model)) throw new ShadowStoreError("Invalid usage attribution", HTTP.badRequest);
    const reported = usage(attempt.usage);
    if (!reported) throw new ShadowStoreError("Missing attempt usage", HTTP.badRequest);
    return { usage: reported, failed: attempt.failed, model: attempt.model };
  });
}
function completionOptions(value: unknown): ArmRecord["options"] {
  if (value === undefined) return undefined;
  if (!object(value)) throw new ShadowStoreError("Invalid completion options", HTTP.badRequest);
  const options: NonNullable<ArmRecord["options"]> = {};
  if (value.maxTokens !== undefined) {
    if (!Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) <= 0) throw new ShadowStoreError("Invalid output limit", HTTP.badRequest);
    options.maxTokens = value.maxTokens as number;
  }
  if (value.effort !== undefined) options.effort = modelEffort(value.effort);
  return options;
}
function modelEffort(value: unknown): string {
  if (typeof value !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(value)) throw new ShadowStoreError("Invalid effort", HTTP.badRequest);
  return value;
}
function failureClassification(record: Record<string, unknown>, scrubber: ScrubEngine): Pick<ArmRecord, "status" | "errorKind"> {
  const result: Pick<ArmRecord, "status" | "errorKind"> = {};
  if (record.status !== undefined) result.status = apiStatus(record.status);
  if (record.errorKind !== undefined) {
    if (typeof record.errorKind !== "string" || !/^[a-z_]{1,80}$/.test(record.errorKind)) throw new ShadowStoreError("Invalid API error kind", HTTP.badRequest);
    result.errorKind = correlationId(record.errorKind, scrubber);
  }
  return result;
}
function apiStatus(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new ShadowStoreError("Invalid API status", HTTP.badRequest);
  if ((value as number) < HTTP.minimum || (value as number) > HTTP.maximum) throw new ShadowStoreError("Invalid API status", HTTP.badRequest);
  return value as number;
}

function validatePromptHashes(record: Record<string, unknown>): void {
  const known = (value: unknown) => hash(value) || value === null && ["unavailable", "aborted"].includes(record.outcome as string);
  if (!known(record.inputHash) || !known(record.promptHash)) throw new ShadowStoreError("Invalid prompt hashes", HTTP.badRequest);
}
