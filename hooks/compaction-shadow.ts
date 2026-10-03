import type { EngineInterface, SessionCompactInput, SessionCompactResult, SessionMessage } from "claude-code";
import { captureHeaderModel, executeHeaderFork, executeHeaderPair, type HeaderCall, type HeaderOutcome, type SessionModelAtCut } from "./compaction-header.js";
import { sharedSessionOutputBudget } from "./model-budget.js";

export type ShadowEngine = { session: Pick<EngineInterface["session"], "id" | "cwd" | "model">; model: Pick<EngineInterface["model"], "fork" | "complete">; env: Pick<EngineInterface["env"], "get"> };

type Message = { role: "user" | "assistant"; text: string; handle?: string };
export type ShadowTransport = { post(route: string, body: unknown): Promise<{ body: Record<string, unknown> | null; httpStatus?: number }>; observe(status: string, reason: string, sessionId?: string): void };
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type Cut = {
  sessionId: string; cwd: string; cutId: string; snapshotHash: string; sourceHash: string; model: SessionModelAtCut; fork?: HeaderCall;
  ready: Deferred<HeaderCall>; paired: Deferred<void>; cancel: Deferred<void>; messages: readonly SessionMessage[]; appended: { uuid: string; text: string }[];
  cancelled: boolean; complete?: HeaderCall; startedAt: number; setupMs: number; nativeMs: number; pairingMs: number; hookMs: number;
};
type BoundaryEpoch = { uuid: string; epoch: number };
export class ShadowSessionState {
  private epochs = new Map<string, number>();
  private boundaries = new Map<string, string>();
  private cuts = new Map<string, Set<Cut>>();
  private tasks = new Set<Promise<void>>();
  boundary(sessionId: string): string | undefined { return this.boundaries.get(sessionId); }
  epoch(sessionId: string): number { return this.epochs.get(sessionId) ?? 0; }
  freezeBoundaries(): ReadonlyMap<string, BoundaryEpoch> {
    return new Map([...this.boundaries].map(([sessionId, uuid]) => [sessionId, { uuid, epoch: this.epoch(sessionId) }]));
  }
  restore(sessionId: string, uuid: string, previous?: string): void {
    if (this.boundaries.get(sessionId) !== uuid) return;
    if (previous === undefined) this.boundaries.delete(sessionId); else this.boundaries.set(sessionId, previous);
  }
  append(sessionId: string, { uuid, text, door }: { uuid: string; text: string; door: string }): void {
    this.boundaries.set(sessionId, uuid);
    if (door === "compaction") this.cuts.get(sessionId)?.forEach(cut => cut.appended.push({ uuid, text }));
  }
  reset(sessionId: string): void {
    this.epochs.set(sessionId, this.epoch(sessionId) + 1);
    this.boundaries.delete(sessionId);
    this.cuts.get(sessionId)?.forEach(cancelCut);
  }
  add(cut: Cut): void { const cuts = this.cuts.get(cut.sessionId) ?? new Set<Cut>(); cuts.add(cut); this.cuts.set(cut.sessionId, cuts); }
  remove(cut: Cut): void { this.cuts.get(cut.sessionId)?.delete(cut); }
  own(task: Promise<void>, transport: ShadowTransport): void {
    const handled = task.catch(() => { transport.observe("unconfirmed", "background"); }).finally(() => this.tasks.delete(handled));
    this.tasks.add(handled);
  }
}
function cancelCut(cut: Cut): void {
  cut.cancelled = true; cut.cancel.resolve(); cut.ready.reject(new Error("dispatch ended"));
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function descriptors(messages: readonly SessionMessage[]): Message[] { return messages.map(row => ({ role: row.role, text: row.text, ...(row.handle ? { handle: row.handle } : {}) })); }
function jobCall(value: unknown, kind: "fork" | "complete", sourceHash: string): HeaderCall {
  if (!object(value)) throw new Error("header job unavailable");
  const prompt = kind === "fork" ? value.forkPrompt : value.completePrompt;
  const promptHash = kind === "fork" ? value.forkPromptHash : value.promptHash;
  if (typeof prompt !== "string" || typeof promptHash !== "string" || typeof value.inputHash !== "string") throw new Error("invalid header job");
  return { prompt, promptHash, inputHash: kind === "fork" ? sourceHash : value.inputHash, evidence: value.evidence as HeaderCall["evidence"] };
}
type Invocation = { event: SessionCompactInput; next(event: SessionCompactInput): Promise<SessionCompactResult>; state: ShadowSessionState; cap: number; signal?: AbortSignal };
export async function runCompactionShadow(engine: ShadowEngine, call: Invocation, transport: ShadowTransport): Promise<SessionCompactResult> {
  if (call.event.agentId !== undefined || call.event.trigger === "precompute") return call.next(call.event);
  const startedAt = performance.now();
  const cut = await captureCut(engine, call, transport);
  if (!cut) return call.next(call.event);
  cut.startedAt = startedAt; cut.setupMs = performance.now() - startedAt;
  call.state.add(cut);
  const boundTransport: ShadowTransport = { post: transport.post, observe: (status, reason) => transport.observe(status, reason, cut!.sessionId) };
  const abort = () => cancelCut(cut);
  call.signal?.addEventListener("abort", abort, { once: true });
  if (call.signal?.aborted) abort();
  try {
    if (cut.cancelled) deliverUnstarted({ cut, state: call.state, outcome: "aborted" }, boundTransport);
    else startArms(engine, { cut, state: call.state, cap: call.cap }, boundTransport);
  } catch {
    boundTransport.observe("unavailable", "executor");
    deliverUnstarted({ cut, state: call.state, outcome: "unavailable" }, boundTransport);
  }
  try { return await nativeAtCut(call, cut, boundTransport); }
  finally { call.signal?.removeEventListener("abort", abort); }
}
async function captureCut(engine: ShadowEngine, call: Invocation, transport: ShadowTransport): Promise<Cut | undefined> {
  try {
    const frozen = structuredClone(call.event), boundaries = call.state.freezeBoundaries();
    const [identity, worker] = await Promise.all([
      Promise.all([engine.session.id(), engine.session.cwd(), captureHeaderModel(engine)]),
      engine.env.get("LCM_SUMMARIZE_WORKER").catch(() => undefined),
    ]);
    if (worker === "1") return undefined;
    return await admit({ identity, frozen, boundaries, state: call.state }, transport);
  } catch { transport.observe("unavailable", "admission"); return undefined; }
}
async function nativeAtCut(call: Invocation, cut: Cut, transport: ShadowTransport): Promise<SessionCompactResult> {
  let result: SessionCompactResult;
  const nativeAt = performance.now();
  try { result = await call.next(call.event); }
  catch (error) { cut.nativeMs = performance.now() - nativeAt; await pairNative(cut, null, transport); throw error; }
  cut.nativeMs = performance.now() - nativeAt; await pairNative(cut, result, transport);
  return result;
}
function deliverUnstarted({ cut, state, outcome }: { cut: Cut; state: ShadowSessionState; outcome: "unavailable" | "aborted" }, transport: ShadowTransport): void {
  state.own(cut.paired.promise.then(async () => {
    await Promise.all((["A", "B", "C"] as const).map(arm => postArm(cut, outcome === "aborted" ? cancelledArm(cut, arm) : unavailableArm(cut, arm), transport)));
  }).finally(() => state.remove(cut)), transport);
}
function startArms(engine: ShadowEngine, { cut, state, cap }: { cut: Cut; state: ShadowSessionState; cap: number }, transport: ShadowTransport): void {
  const budget = sharedSessionOutputBudget(cut.sessionId, cap);
  const fork = cut.fork ? executeHeaderFork(engine, cut.fork, { model: cut.model, budget }).catch(() => unavailableArm(cut, "A")) : Promise.resolve(unavailableArm(cut, "A"));
  const forkDelivery = deliverFork(fork, cut, transport);
  state.own(forkDelivery, transport);
  const input = cut.fork ? cut.ready.promise : cut.ready.promise.then(() => { throw new Error("admitted input unavailable"); });
  let pairStarted = false;
  const activeEngine: ShadowEngine = { ...engine, model: { ...engine.model, complete: (request, options) => {
    if (cut.cancelled) return Promise.reject(new Error("session ended"));
    pairStarted = true; return engine.model.complete(request, options);
  } } };
  const pair = executeHeaderPair(activeEngine, input, { model: cut.model, budget, canStart: () => !cut.cancelled }).catch(() => ({ B: unavailableArm(cut, "B"), C: unavailableArm(cut, "C") }));
  const pairDelivery = Promise.race([pair, cut.cancel.promise.then(() => pairStarted ? pair : ({ B: cancelledArm(cut, "B"), C: cancelledArm(cut, "C") }))]).then(async outcomes => {
    await cut.paired.promise;
    await Promise.all([postArm(cut, outcomes.B, transport), postArm(cut, outcomes.C, transport)]);
  });
  state.own(pairDelivery, transport);
  state.own(Promise.all([forkDelivery, pairDelivery]).then(() => state.remove(cut), () => state.remove(cut)), transport);
}
type AdmissionInput = { identity: [string, string, SessionModelAtCut]; frozen: SessionCompactInput; boundaries: ReadonlyMap<string, BoundaryEpoch>; state: ShadowSessionState };
async function admit({ identity: [sessionId, cwd, model], frozen, boundaries, state }: AdmissionInput, transport: ShadowTransport): Promise<Cut | undefined> {
  const { messages, instructions, trigger } = frozen;
  const boundary = boundaries.get(sessionId);
  if (!boundary) { transport.observe("unavailable", "boundary", sessionId); return undefined; }
  const cutId = crypto.randomUUID();
  const response = await transport.post("/compaction-shadow/start", { cwd, session_id: sessionId, cut_id: cutId, model: model.id, trigger, instructions,
    boundary_uuid: boundary.uuid, engine_messages: descriptors(messages), prepare_header: true });
  const cut = admittedCut(response.body, { sessionId, cwd, model, cutId, messages }, transport);
  if (cut && state.epoch(sessionId) !== boundary.epoch) cancelCut(cut);
  return cut;
}
type AdmissionIdentity = Pick<Cut, "sessionId" | "cwd" | "model" | "cutId" | "messages">;
function admittedCut(body: unknown, identity: AdmissionIdentity, transport: ShadowTransport): Cut | undefined {
  if (!object(body) || body.admitted !== true) { transport.observe("unavailable", refusalReason(body)); return undefined; }
  const { cut, snapshot } = admittedBinding(body, identity.cutId);
  let fork: HeaderCall | undefined;
  try { fork = jobCall(body.job, "fork", snapshot.sourceHash as string); }
  catch { transport.observe("unavailable", "header-input"); }
  return { ...identity, snapshotHash: cut.snapshotHash as string, sourceHash: snapshot.sourceHash as string, fork,
    ready: deferred<HeaderCall>(), paired: deferred<void>(), cancel: deferred<void>(), appended: [], cancelled: false,
    startedAt: 0, setupMs: 0, nativeMs: 0, pairingMs: 0, hookMs: 0 };
}
function refusalReason(body: unknown): string { return object(body) && typeof body.reason === "string" ? body.reason : "admission"; }
function admittedBinding(body: Record<string, unknown>, cutId: string) {
  if (!object(body.cut) || !object(body.snapshot)) throw new Error("cut binding unavailable");
  if (body.cut.cutId !== cutId || typeof body.cut.snapshotHash !== "string" || typeof body.snapshot.sourceHash !== "string") throw new Error("cut identity mismatch");
  return { cut: body.cut, snapshot: body.snapshot };
}
function unavailableArm(cut: Cut, arm: "A" | "B" | "C"): HeaderOutcome {
  return { arm, outcome: "unavailable", header: null, text: "", usage: null, requestedModel: arm === "C" ? "sonnet" : cut.model.id,
    inputHash: null, promptHash: null, durationMs: 0, queueMs: 0 };
}

function binding(cut: Cut) { return { cwd: cut.cwd, session_id: cut.sessionId, cut_id: cut.cutId, snapshot_hash: cut.snapshotHash }; }
async function deliverFork(fork: Promise<HeaderOutcome>, cut: Cut, transport: ShadowTransport): Promise<void> {
  const result = await fork;
  await cut.paired.promise; await postArm(cut, result, transport);
}
function cancelledArm(cut: Cut, arm: "A" | "B" | "C"): HeaderOutcome {
  const input = arm === "A" ? cut.fork : cut.complete;
  return { arm, outcome: "aborted", header: null, text: "", usage: null, requestedModel: arm === "C" ? "sonnet" : cut.model.id,
    inputHash: input?.inputHash ?? null, promptHash: input?.promptHash ?? null, durationMs: 0, queueMs: 0 };
}
async function postArm(cut: Cut, result: HeaderOutcome, transport: ShadowTransport): Promise<void> {
  const timings = { setupMs: cut.setupMs, nativeMs: cut.nativeMs, pairingMs: cut.pairingMs, hookMs: cut.hookMs };
  const response = await transport.post("/compaction-shadow/arm", { ...binding(cut), arm: result.arm, attempt_id: "first", record: { ...result, timings, costUsd: null, usageAttempts: [] } });
  if (!response.body?.stored) transport.observe("unconfirmed", "arm-delivery");
}
function extractedNative(cut: Cut, result: SessionCompactResult | null) {
  if (!result || result.skip !== undefined) return { text: "", outcome: result ? "skipped" : "aborted", fidelity: result ? "skipped" : "aborted", tail: [], observedMessages: [], candidateIndices: [] };
  const original = new Map(cut.messages.map((message, index) => [message.handle, { message, index }]));
  const candidates = result.messages.flatMap((message, index) => !message.handle || !original.has(message.handle) ? [index] : []);
  const observedMessages = descriptors(result.messages);
  if (original.size !== cut.messages.length || original.has(undefined)) return { text: "", outcome: "unavailable", fidelity: "native-tail-unverified", tail: [], observedMessages, candidateIndices: candidates };
  if (!uniqueSummary(candidates)) return { text: "", outcome: "unavailable", fidelity: "native-summary-unverified", tail: [], observedMessages, candidateIndices: candidates };
  const tail = result.messages.slice(1);
  if (!tailMatches(tail, original)) return { text: "", outcome: "unavailable", fidelity: "native-tail-unverified", tail: [], observedMessages, candidateIndices: candidates };
  const summary = result.messages[0], rows = cut.appended.filter(row => row.text === summary.text);
  return { text: summary.text, outcome: "answered", fidelity: "verified", tail: descriptors(tail), observedMessages, candidateIndices: candidates,
    ...(rows.length === 1 ? { summaryUuid: rows[0].uuid } : {}), usage: result.usage, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter };
}
function uniqueSummary(indices: readonly number[]): boolean { return indices.length === 1 && indices[0] === 0; }

function tailMatches(tail: readonly SessionMessage[], original: ReadonlyMap<string | undefined, { message: SessionMessage; index: number }>): boolean {
  let prior = -1;
  return tail.every(message => {
    const source = original.get(message.handle);
    if (!source || source.index <= prior) return false;
    if (!sameMessage(source.message, message)) return false;
    prior = source.index; return true;
  });
}
function sameMessage(before: SessionMessage, after: SessionMessage): boolean { return before.role === after.role && before.text === after.text; }

async function pairNative(cut: Cut, result: SessionCompactResult | null, transport: ShadowTransport): Promise<void> {
  const pairingAt = performance.now();
  try {
    const record = { ...extractedNative(cut, result), durationMs: cut.nativeMs };
    const response = await transport.post("/compaction-shadow/native", { ...binding(cut), record, prepare_header: true });
    if (record.fidelity !== "verified" || !response.body?.stored || !response.body.job) throw new Error("native input unavailable");
    cut.complete = jobCall(response.body.job, "complete", cut.sourceHash);
    cut.ready.resolve(cut.complete);
  } catch { cut.ready.reject(new Error("native pairing unavailable")); transport.observe("unavailable", "native-pairing"); }
  finally { cut.pairingMs = performance.now() - pairingAt; cut.hookMs = performance.now() - cut.startedAt; cut.paired.resolve(); }
}
