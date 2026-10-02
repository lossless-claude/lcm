import { ScrubEngine } from "../../scrub.js";
import { ShadowStoreError } from "./store.js";
import { HTTP, HEADER_SECTIONS, digest, hash, object, safeId, nonnegative, validHeader, validUsage,
  type ArmRecord, type NativeRecord, type ShadowMessage, type ShadowHeader, type ShadowUsage } from "./types.js";

const OUTCOMES = new Set(["answered", "skipped", "nothing-to-fork", "api-error", "empty-reply", "aborted", "invalid-output", "unavailable", "spend-cap", "unconfirmed"]);
function validEngineMessage(row: unknown): boolean {
  if (!object(row)) return false;
  if (typeof row.role !== "string" || !["user", "assistant"].includes(row.role)) return false;
  if (typeof row.text !== "string") return false;
  return row.handle === undefined || typeof row.handle === "string";
}
export function shadowMessages(value: unknown, scrubber: ScrubEngine): ShadowMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !validEngineMessage(row)))
    throw new ShadowStoreError("Invalid engine messages", HTTP.badRequest);
  return value.map(row => ({ role: row.role, text: scrubber.scrub(row.text), ...(row.handle !== undefined ? { handle: row.handle } : {}) }));
}
function header(value: unknown, scrubber: ScrubEngine): ShadowHeader | null {
  if (value === undefined || value === null) return null;
  if (!validHeader(value)) throw new ShadowStoreError("Invalid header", HTTP.badRequest);
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
  if (record.summaryUuid !== undefined && !safeId(record.summaryUuid)) throw new ShadowStoreError("Invalid summary uuid", HTTP.badRequest);
  return { ...base, tail: shadowMessages(record.tail, scrubber), rawTextHash: digest(record.text as string), rawTextBytes: Buffer.byteLength(record.text as string, "utf8"),
    ...(record.summaryUuid ? { summaryUuid: record.summaryUuid as string } : {}),
    ...(record.tokensBefore !== undefined ? { tokensBefore: measurement(record.tokensBefore)! } : {}),
    ...(record.tokensAfter !== undefined ? { tokensAfter: measurement(record.tokensAfter)! } : {}),
    ...(record.hookAddedMs !== undefined ? { hookAddedMs: measurement(record.hookAddedMs)! } : {}),
  };
}
export function armRecord(input: Record<string, unknown>, record: Record<string, unknown>, scrubber: ScrubEngine): ArmRecord {
  validateArmIdentity(input, record);
  const attempts = usageAttempts(record.usageAttempts, scrubber);
  const options = completionOptions(record.options);
  const classification = failureClassification(record);
  return { ...basicRecord(record, scrubber), arm: input.arm as ArmRecord["arm"], attemptId: input.attempt_id as string,
    requestedModel: scrubber.scrub(record.requestedModel as string), inputHash: record.inputHash as string, promptHash: record.promptHash as string, header: header(record.header, scrubber),
    usageAttempts: attempts, ...classification, ...(options ? { options } : {}),
  };
}


function validateArmIdentity(input: Record<string, unknown>, record: Record<string, unknown>): void {
  if (typeof input.arm !== "string" || !["A", "B", "C"].includes(input.arm)) throw new ShadowStoreError("Invalid arm", HTTP.badRequest);
  if (!safeId(input.attempt_id)) throw new ShadowStoreError("Invalid attempt", HTTP.badRequest);
  if (typeof record.requestedModel !== "string" || !record.requestedModel) throw new ShadowStoreError("Invalid model", HTTP.badRequest);
  validatePromptHashes(record);
}
function usageAttempts(value: unknown, scrubber: ScrubEngine): ArmRecord["usageAttempts"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ShadowStoreError("Invalid usage attempts", HTTP.badRequest);
  return value.map(attempt => {
    if (!object(attempt)) throw new ShadowStoreError("Invalid usage attempt", HTTP.badRequest);
    if (typeof attempt.failed !== "boolean" || typeof attempt.model !== "string") throw new ShadowStoreError("Invalid usage attribution", HTTP.badRequest);
    const reported = usage(attempt.usage);
    if (!reported) throw new ShadowStoreError("Missing attempt usage", HTTP.badRequest);
    return { usage: reported, failed: attempt.failed, model: scrubber.scrub(attempt.model) };
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
function failureClassification(record: Record<string, unknown>): Pick<ArmRecord, "status" | "errorKind"> {
  const result: Pick<ArmRecord, "status" | "errorKind"> = {};
  if (record.status !== undefined) result.status = apiStatus(record.status);
  if (record.errorKind !== undefined) {
    if (typeof record.errorKind !== "string" || !/^[a-z_]{1,80}$/.test(record.errorKind)) throw new ShadowStoreError("Invalid API error kind", HTTP.badRequest);
    result.errorKind = record.errorKind;
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
  if (!hash(record.inputHash) || !hash(record.promptHash)) throw new ShadowStoreError("Invalid prompt hashes", HTTP.badRequest);
}
