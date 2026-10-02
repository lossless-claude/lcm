import { createHash } from "node:crypto";
import type { ContextCoverage } from "../../store/summary-store.js";

export const HTTP = { ok: 200, badRequest: 400, notFound: 404, conflict: 409, gone: 410, unprocessable: 422, minimum: 100, maximum: 599 } as const;
export const SHADOW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const HEADER_SECTIONS = ["directives", "intent", "decisions", "taskAndNextStep", "openThreads", "files", "errors"] as const;
export type HeaderItem = { text: string; sources: (string | { quote: string })[]; status?: string; supersedes?: string[]; fix?: string };
export type ShadowHeader = { version: 1 } & Record<typeof HEADER_SECTIONS[number], HeaderItem[]>;
export type ShadowUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
export type ShadowMessage = { role: "user" | "assistant"; text: string; handle?: string };
export type ShadowOriginal = { id: number; seq: number; role: string; text: string; uuid?: string; origin: "user" | "other" | "unknown" };
export type ShadowSnapshot = {
  version: 1; originals: ShadowOriginal[]; engineMessages: ShadowMessage[];
  window: { text: string; coverage: ContextCoverage };
  sourceHash: string;
};
export type ShadowManifest = {
  version: 1; cutId: string; projectId: string; cwd: string; sessionId: string; conversationId: number;
  boundaryUuid: string; model: string; trigger: "manual" | "auto" | "plugin"; instructions: string;
  snapshotHash: string; rulesKey: string; createdAt: string; expiresAt: string;
  state: "pending" | "complete" | "incomplete"; owner: string; expectedArms: ("A" | "B" | "C")[];
};
export type NativeRecord = {
  text: string; outcome: string; usage: ShadowUsage | null; durationMs: number | null;
  tail: ShadowMessage[]; rawTextHash: string; rawTextBytes: number; summaryUuid?: string;
  tokensBefore?: number; tokensAfter?: number; hookAddedMs?: number; costUsd: number | null;
};
export type ArmRecord = {
  arm: "A" | "B" | "C"; attemptId: string; text: string; header: ShadowHeader | null;
  outcome: string; requestedModel: string; usage: ShadowUsage | null; durationMs: number | null;
  inputHash: string; promptHash: string; costUsd: number | null;
  usageAttempts: { usage: ShadowUsage; failed: boolean; model: string }[];
  status?: number | null; errorKind?: string;
  options?: { maxTokens?: number; effort?: string };
};
export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
export const objectHash = (value: unknown): string => digest(JSON.stringify(value));
export const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,140}$/.test(value);
export const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function validUsage(value: unknown): value is ShadowUsage {
  return object(value) && ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    .every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}
export function validHeader(value: unknown): value is ShadowHeader {
  if (!object(value) || value.version !== 1) return false;
  return HEADER_SECTIONS.every(key => Array.isArray(value[key]) && value[key].every((item: unknown) =>
    object(item) && typeof item.text === "string" && item.text.trim().length > 0 && Array.isArray(item.sources) && item.sources.length > 0 &&
    item.sources.every((source: unknown) => typeof source === "string" || object(source) && typeof source.quote === "string")));
}
