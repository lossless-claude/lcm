import type { EngineInterface } from "claude-code";
import type { SessionOutputBudget } from "./model-budget.js";
import { validCompactionHeader, validModelName, type CompactionHeader } from "./compaction-header-schema.js";

type HeaderEngine = { session: Pick<EngineInterface["session"], "model">; model: Pick<EngineInterface["model"], "fork" | "complete"> };
export type HeaderCall = { prompt: string; inputHash: string; promptHash: string; maxTokens?: number };
const CAPTURED_MODEL = Symbol("session model at cut");
export type SessionModelAtCut = { readonly id: string; readonly [CAPTURED_MODEL]: true };
export type HeaderUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
type Arm = "A" | "B" | "C";
type HeaderFailure = "api-error" | "empty-reply" | "aborted" | "nothing-to-fork" | "invalid-output" | "unavailable" | "spend-cap" | "unconfirmed";
type OutcomeMetadata = {
  arm: Arm; requestedModel: string; usage: HeaderUsage | null; inputHash: string | null; promptHash: string | null;
  durationMs: number; queueMs: number; options?: { maxTokens: number }; status?: number | null; errorKind?: string;
  budget?: ReturnType<SessionOutputBudget["snapshot"]>;
};
export type HeaderOutcome = OutcomeMetadata & ({ outcome: "answered"; text: string; header: CompactionHeader } | { outcome: HeaderFailure; text: string; header: null });
type ExecutionContext = { model: SessionModelAtCut; budget: SessionOutputBudget };
export interface HeaderExecutor {
  captureModel($: HeaderEngine): Promise<SessionModelAtCut>;
  fork($: HeaderEngine, job: HeaderCall, context: ExecutionContext): Promise<HeaderOutcome>;
  pair($: HeaderEngine, job: Promise<HeaderCall>, context: ExecutionContext): Promise<{ B: HeaderOutcome; C: HeaderOutcome }>;
}
const DEFAULT_HEADER_MAX_TOKENS = 4096;
const MAX_COMPLETION_TOKENS = 64_000;
const CLEAN_HEADER_ARMS = 2;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export async function captureHeaderModel($: HeaderEngine): Promise<SessionModelAtCut> {
  const id = await $.session.model();
  if (!validModelName(id)) throw new Error("Invalid session model identifier");
  return Object.freeze({ id, [CAPTURED_MODEL]: true as const });
}
type CallContext = { arm: Arm; model: string; job?: HeaderCall; queuedAt: number; startedAt: number; maxTokens?: number };
function metadata(call: CallContext, usage: HeaderUsage | null): OutcomeMetadata {
  return { arm: call.arm, requestedModel: call.model, inputHash: call.job?.inputHash ?? null, promptHash: call.job?.promptHash ?? null, usage,
    durationMs: Date.now() - call.startedAt, queueMs: call.startedAt - call.queuedAt,
    ...(call.maxTokens !== undefined ? { options: { maxTokens: call.maxTokens } } : {}) };
}
function failure(call: CallContext, outcome: HeaderFailure, usage: HeaderUsage | null = null): HeaderOutcome {
  return { ...metadata(call, usage), outcome, header: null, text: "" };
}
function readUsage(value: unknown): HeaderUsage | null {
  if (!object(value)) return null;
  const keys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  if (!keys.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return null;
  return { input_tokens: value.input_tokens as number, output_tokens: value.output_tokens as number,
    cache_read_input_tokens: value.cache_read_input_tokens as number, cache_creation_input_tokens: value.cache_creation_input_tokens as number };
}
function answered(call: CallContext, text: string, usage: HeaderUsage): HeaderOutcome {
  if (!text.trim()) return failure(call, "empty-reply", usage);
  let header: unknown;
  try { header = JSON.parse(text); }
  catch { return { ...failure(call, "invalid-output", usage), text }; }
  if (!validCompactionHeader(header)) return { ...failure(call, "invalid-output", usage), text };
  return { ...metadata(call, usage), outcome: "answered", text, header };
}
function classifyResult(result: unknown, call: CallContext): HeaderOutcome {
  if (!object(result)) return failure(call, "unconfirmed");
  if (nothingToFork(result, call.arm)) return failure(call, "nothing-to-fork");
  const usage = readUsage(result.usage);
  if (!usage) return failure(call, "unconfirmed");
  if (result.isAnswered === true && typeof result.text === "string") return answered(call, result.text, usage);
  return nonAnswer(result, call, usage);
}
function nothingToFork(result: Record<string, unknown>, arm: Arm): boolean {
  return arm === "A" && result.isAnswered === false && result.reason === "nothing-to-fork";
}
function nonAnswer(result: Record<string, unknown>, call: CallContext, usage: HeaderUsage): HeaderOutcome {
  if (result.isAnswered !== false) return failure(call, "invalid-output", usage);
  if (result.reason === "aborted" || result.reason === "empty-reply") return failure(call, result.reason, usage);
  if (result.reason !== "api-error") return failure(call, "unconfirmed", usage);
  const status = typeof result.status === "number" && result.status >= 100 && result.status <= 599 && Number.isInteger(result.status) ? result.status : null;
  const errorKind = typeof result.error === "string" && /^[a-z_]{1,80}$/.exec(result.error)?.[0] === result.error ? result.error : "unknown";
  return { ...failure(call, "api-error", usage), status, errorKind };
}
function outputAccounting(results: readonly HeaderOutcome[]): { known: number; unknown: boolean } {
  return { known: results.reduce((total, row) => total + (row.usage?.output_tokens ?? 0), 0),
    unknown: results.some(row => row.usage === null && row.outcome !== "nothing-to-fork") };
}
export async function executeHeaderFork($: HeaderEngine, job: HeaderCall, { model, budget }: ExecutionContext): Promise<HeaderOutcome> {
  const now = Date.now(), fixed = { ...job }, call: CallContext = { arm: "A", model: model.id, job: fixed, queuedAt: now, startedAt: now };
  const lease = budget.reserveFork();
  if (!lease) return { ...failure(call, budget.snapshot().available ? "unavailable" : "spend-cap"), budget: budget.snapshot() };
  let result: unknown;
  try { result = await $.model.fork({ prompt: fixed.prompt }); }
  catch { result = null; }
  const outcome = classifyResult(result, call), accounted = outputAccounting([outcome]);
  lease.settle(accounted.known, accounted.unknown);
  return { ...outcome, budget: budget.snapshot() };
}
async function completeMember($: HeaderEngine, call: CallContext): Promise<HeaderOutcome> {
  let result: unknown;
  try { result = await $.model.complete({ model: call.model, prompt: call.job!.prompt, maxTokens: call.maxTokens! }); }
  catch { result = null; }
  return classifyResult(result, call);
}
function unavailablePair(model: SessionModelAtCut, queuedAt: number, { job, outcome = "unavailable" }: { job?: HeaderCall; outcome?: HeaderFailure } = {}) {
  const startedAt = Date.now();
  return { B: failure({ arm: "B", model: model.id, job, queuedAt, startedAt }, outcome), C: failure({ arm: "C", model: "sonnet", job, queuedAt, startedAt }, outcome) };
}
export async function executeHeaderPair($: HeaderEngine, ready: Promise<HeaderCall>, { model, budget }: ExecutionContext): Promise<{ B: HeaderOutcome; C: HeaderOutcome }> {
  const queuedAt = Date.now();
  let job: HeaderCall;
  try { job = Object.freeze({ ...await ready }); }
  catch { return unavailablePair(model, queuedAt); }
  const requested = job.maxTokens ?? DEFAULT_HEADER_MAX_TOKENS;
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > MAX_COMPLETION_TOKENS) return unavailablePair(model, queuedAt, { job });
  const lease = await budget.reserveComplete(requested, CLEAN_HEADER_ARMS);
  if (!lease) return unavailablePair(model, queuedAt, { job, outcome: "spend-cap" });
  const common = { job, queuedAt, startedAt: Date.now(), maxTokens: lease.maxTokens! };
  const [B, C] = await Promise.all([completeMember($, { ...common, arm: "B", model: model.id }), completeMember($, { ...common, arm: "C", model: "sonnet" })]);
  const accounted = outputAccounting([B, C]); lease.settle(accounted.known, accounted.unknown);
  return { B: { ...B, budget: budget.snapshot() }, C: { ...C, budget: budget.snapshot() } };
}
export const headerExecutor: HeaderExecutor = { captureModel: captureHeaderModel, fork: executeHeaderFork, pair: executeHeaderPair };
