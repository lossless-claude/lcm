import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { workingHeader } from "../compaction-header/fixtures.js";

const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 };
const messages = [{ role: "user", text: "Keep working.", handle: "h1", toolUses: [] }, { role: "assistant", text: "In progress", handle: "h2", toolUses: [] }];
const compact = () => ({ trigger: "manual", instructions: "Keep the plan", messages: structuredClone(messages) });
const nativeResult = () => ({ messages: [{ role: "user", text: "  native summary\n", handle: "summary-new", toolUses: [] }, structuredClone(messages[1])], usage });
const job = { forkPrompt: "fork prompt", forkPromptHash: "a".repeat(64), completePrompt: "clean prompt", promptHash: "b".repeat(64), inputHash: "c".repeat(64),
  evidence: { cutId: "cut", originals: [{ id: 1, text: "Keep working." }], excerpts: [{ id: "u1", rawMessageId: 1 }], summaries: [] } };
async function setup(enabled: boolean | null = true) {
  const handlers = new Map<string, ((...args: any[]) => any)[]>(), posts: { route: string; body: any }[] = [];
  const engine = {
    env: { get: vi.fn(async () => undefined) }, session: { id: vi.fn(async () => "session-a"), cwd: vi.fn(async () => "/proj"), model: vi.fn(async () => "session-model") },
    model: { fork: vi.fn(async () => ({ isAnswered: true, text: JSON.stringify(workingHeader()), usage })), complete: vi.fn(async () => ({ isAnswered: true, text: JSON.stringify(workingHeader()), usage })) },
    process: { run: vi.fn(async () => ({ stdout: "secret\n__CONFIG__\n{}\n__TMPDIR__/tmp", exitCode: 0 })) },
    fs: { write: vi.fn(async () => undefined) }, clock: { after: vi.fn(), sleep: vi.fn(() => new Promise(() => {})) }, ui: { log: vi.fn() },
    http: { fetch: vi.fn(async (url: string, init?: any) => {
      const route = new URL(url).pathname, body = init?.body ? JSON.parse(init.body) : {};
      posts.push({ route, body });
      const response = route.endsWith("/start") ? { admitted: true, cut: { cutId: body.cut_id, snapshotHash: "d".repeat(64) }, snapshot: { sourceHash: "e".repeat(64) }, job }
        : route.endsWith("/native") ? { stored: true, job } : { stored: true };
      return { ok: true, status: 200, text: JSON.stringify(response) };
    }) },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => { handlers.set(event, [...handlers.get(event) ?? [], args.at(-1)]); }) as any,
    { sessionSummarizerMaxOutputTokens: 100, ...(enabled === null ? {} : { compactionShadow: enabled }) });
  async function fire(event: string, input: any, next = vi.fn(async (value: any) => value)) {
    const chain = handlers.get(event) ?? [];
    const invoke = (index: number, value: any): any => index === chain.length ? next(value) : chain[index](engine, value, Object.assign((updated: any) => invoke(index + 1, updated), { signal: (next as any).signal }));
    return invoke(0, input);
  }
  async function append(uuid = "boundary") {
    const e = { uuid, door: "response", origin: { kind: "model", model: "session-model" }, message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "In progress" }] } };
    const result = { uuid, message: e.message };
    const next = vi.fn(async () => result); expect(await fire("session.append", e, next)).toBe(result); expect(next).toHaveBeenCalledWith(e);
  }
  return { engine, posts, handlers, fire, append };
}
describe("opt-in compaction shadow hook", () => {
  beforeEach(() => vi.resetModules());
  it("declares a default-off option with explicit spending disclosure", () => {
    const config = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8")).userConfig.compactionShadow;
    expect(config).toMatchObject({ type: "boolean", default: false }); expect(config.description).toMatch(/substantial.*spend/i);
  });
  it.each([false, null])("does no shadow request or model work with option %s", async enabled => {
    const harness = await setup(enabled), e = compact(), result = nativeResult(), next = vi.fn(async () => result);
    await harness.append(); expect(await harness.fire("session.compact", e, next)).toBe(result);
    expect(next).toHaveBeenCalledTimes(1); expect(harness.posts).toEqual([]); expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("starts fork before native, preserves input/result identity and pairs every arm with the cut", async () => {
    const harness = await setup(), order: string[] = [], e = compact(), result = nativeResult();
    harness.engine.model.fork.mockImplementation(async () => { order.push("fork"); return { isAnswered: true, text: JSON.stringify(workingHeader()), usage }; });
    await harness.append(); const next = vi.fn(async (input: any) => { order.push("next"); expect(input).toBe(e); return result; });
    expect(await harness.fire("session.compact", e, next)).toBe(result);
    expect(next).toHaveBeenCalledTimes(1); expect(order).toEqual(["fork", "next"]);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    const admission = harness.posts.find(post => post.route.endsWith("/start"))!;
    expect(admission.body).toMatchObject({ boundary_uuid: "boundary", model: "session-model", instructions: e.instructions });
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record).toMatchObject({ text: "  native summary\n", tail: [{ handle: "h2" }], fidelity: "verified" });
    for (const post of harness.posts.filter(post => post.route.endsWith("/arm"))) expect(post.body.cut_id).toBe(admission.body.cut_id);
    expect(harness.posts.find(post => post.body.arm === "A")!.body.record.timings).toMatchObject({ setupMs: expect.any(Number), nativeMs: expect.any(Number), pairingMs: expect.any(Number), hookMs: expect.any(Number) });
  });
  it.each([{ trigger: "precompute" }, { agentId: "subagent" }, { agentId: "fork-loop" }])("passes ineligible loops through unchanged (%j)", async change => {
    const harness = await setup(), event = { ...compact(), ...change }, result = nativeResult(), next = vi.fn(async () => result);
    await harness.append(); expect(await harness.fire("session.compact", event, next)).toBe(result);
    expect(next).toHaveBeenCalledWith(event); expect(harness.posts).toEqual([]); expect(harness.engine.model.fork).not.toHaveBeenCalled();
  });
  it("passes worker sessions through without shadow calls", async () => {
    const harness = await setup(); harness.engine.env.get.mockResolvedValue("1");
    const result = nativeResult(); expect(await harness.fire("session.compact", compact(), vi.fn(async () => result))).toBe(result);
    expect(harness.posts).toEqual([]); expect(harness.engine.model.fork).not.toHaveBeenCalled();
  });
  it("returns native while A/B/C remain pending and pairs out-of-order completion correctly", async () => {
    const harness = await setup(), fork = Promise.withResolvers<any>(), beta = Promise.withResolvers<any>(), gamma = Promise.withResolvers<any>();
    harness.engine.model.fork.mockImplementation(() => fork.promise);
    harness.engine.model.complete.mockImplementationOnce(() => beta.promise).mockImplementationOnce(() => gamma.promise);
    await harness.append(); const result = nativeResult();
    expect(await harness.fire("session.compact", compact(), vi.fn(async () => result))).toBe(result);
    expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(0);
    fork.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    await vi.waitFor(() => expect(harness.engine.model.complete).toHaveBeenCalledTimes(2));
    gamma.resolve({ isAnswered: false, reason: "api-error", status: 400, error: "invalid_request", usage });
    beta.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.find(post => post.body.arm === "C")!.body.record.outcome).toBe("api-error");
  });
  it("keeps two consecutive cuts distinct with frozen identities", async () => {
    const harness = await setup(); await harness.append("cut-one");
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    await harness.append("cut-two"); harness.engine.session.model.mockResolvedValue("new-model");
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(6));
    const starts = harness.posts.filter(post => post.route.endsWith("/start"));
    expect(starts[0].body.cut_id).not.toBe(starts[1].body.cut_id);
    expect(starts.map(post => post.body.boundary_uuid)).toEqual(["cut-one", "cut-two"]);
    expect(starts.map(post => post.body.model)).toEqual(["session-model", "new-model"]);
  });
  it.each(["clear", "resume", "fork"])("resets observed state on classic SessionStart %s", async source => {
    const harness = await setup(); await harness.append();
    await harness.fire("classic.SessionStart", { session_id: "session-a", source });
    const before = harness.posts.filter(post => post.route.startsWith("/compaction-shadow")).length;
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    expect(harness.posts.filter(post => post.route.startsWith("/compaction-shadow"))).toHaveLength(before);
    expect(harness.engine.model.fork).not.toHaveBeenCalled();
  });
  it("cancels unfinished arms on unload after native returned", async () => {
    const harness = await setup(); harness.engine.model.fork.mockImplementation(() => new Promise<any>(() => {}));
    await harness.append(); await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await harness.fire("session.end", { sessionId: "session-a", reason: "other" });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.filter(post => post.route.endsWith("/arm")).every(post => post.body.record.outcome === "aborted")).toBe(true);
  });
  it("records native skip and unavailable clean arms without changing the skip object", async () => {
    const harness = await setup(); await harness.append(); const skipped = { skip: "blocked" };
    expect(await harness.fire("session.compact", compact(), vi.fn(async () => skipped))).toBe(skipped);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record.fidelity).toBe("skipped");
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("never guesses multiple native summary candidates", async () => {
    const harness = await setup(); await harness.append(); const result = { messages: [{ role: "user", text: "one", toolUses: [] }, { role: "user", text: "two", toolUses: [] }] };
    expect(await harness.fire("session.compact", compact(), vi.fn(async () => result))).toBe(result);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record).toMatchObject({ fidelity: "native-summary-unverified", candidateIndices: [0, 1], text: "" });
  });
  it("does not resolve repeated original handles by guessing", async () => {
    const harness = await setup(); await harness.append(); const event = compact(); event.messages[1] = { ...event.messages[0] };
    const result = { messages: [nativeResult().messages[0], structuredClone(event.messages[0])] };
    await harness.fire("session.compact", event, vi.fn(async () => result));
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record.fidelity).toBe("native-tail-unverified");
  });
  it("records cap refusal for each arm without making a model call", async () => {
    const harness = await setup(); await harness.append();
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    (await sharedSessionOutputBudget("session-a", 100).reserveComplete(100))!.settle(100);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.filter(post => post.route.endsWith("/arm")).every(post => post.body.record.outcome === "spend-cap")).toBe(true);
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it.each(["refused", "transport", "storage"])("lets native succeed after shadow %s failure", async mode => {
    const harness = await setup(); await harness.append(); const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      if (url.endsWith(mode === "storage" ? "/native" : "/start")) {
        if (mode === "transport") throw new Error("socket dropped");
        return { ok: mode === "refused", status: mode === "refused" ? 200 : 500, text: JSON.stringify(mode === "refused" ? { admitted: false, reason: "excluded" } : { error: "failed" }) };
      }
      return fetch(url, init);
    });
    const event = compact(), result = nativeResult(), next = vi.fn(async () => result);
    expect(await harness.fire("session.compact", event, next)).toBe(result); expect(next).toHaveBeenCalledTimes(1);
    if (mode !== "storage") expect(harness.engine.model.fork).not.toHaveBeenCalled();
  });
  it("does not await pending arm storage before returning native", async () => {
    const harness = await setup(); await harness.append(); const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation((url, init) => url.endsWith("/arm") ? new Promise<any>(() => {}) : fetch(url, init));
    const result = nativeResult(); expect(await harness.fire("session.compact", compact(), vi.fn(async () => result))).toBe(result);
  });
  it("preserves a native rejection after an abort and records unavailable native evidence", async () => {
    const harness = await setup(); await harness.append(); const abort = new AbortController(), original = new Error("native aborted");
    harness.engine.model.fork.mockImplementation(() => new Promise<any>(() => {}));
    const next = Object.assign(vi.fn(async () => { abort.abort(); throw original; }), { signal: abort.signal });
    await expect(harness.fire("session.compact", compact(), next)).rejects.toBe(original);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record.fidelity).toBe("aborted");
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
  });
  it("records every admitted arm as unavailable when its prepared input is absent", async () => {
    const harness = await setup(); await harness.append(); const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith("/start")) { const body = JSON.parse(response.text); delete body.job; return { ...response, text: JSON.stringify(body) }; }
      return response;
    });
    const result = nativeResult(); expect(await harness.fire("session.compact", compact(), vi.fn(async () => result))).toBe(result);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("freezes the original engine descriptors and records native summary append UUID without mutation", async () => {
    const harness = await setup(); await harness.append(); const event = compact(), result = nativeResult();
    const next = vi.fn(async () => {
      event.messages[1].text = "mutated after entry";
      await harness.fire("session.append", { uuid: "summary-row", door: "compaction", origin: { kind: "engine" }, message: { type: "user", role: "user", content: [{ type: "text", text: result.messages[0].text }] } },
        vi.fn(async (e: any) => ({ uuid: e.uuid, message: e.message })));
      return result;
    });
    expect(await harness.fire("session.compact", event, next)).toBe(result);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record).toMatchObject({ fidelity: "verified", summaryUuid: "summary-row" });
  });
  it("freezes input before the first host await", async () => {
    const harness = await setup(); await harness.append(); const event = compact();
    harness.engine.session.id.mockImplementation(async () => { event.messages[0].text = "later mutation"; event.instructions = "later instruction"; return "session-a"; });
    await harness.fire("session.compact", event, vi.fn(async () => nativeResult()));
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body).toMatchObject({ instructions: "Keep the plan", engine_messages: [{ text: "Keep working." }, { text: "In progress" }] });
  });
  it("keeps native successful when the executor cannot acquire its session budget", async () => {
    const harness = await setup(); await harness.append(); const result = nativeResult(), next = vi.fn(async () => result);
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js"); sharedSessionOutputBudget("session-a", 99);
    expect(await harness.fire("session.compact", compact(), next)).toBe(result); expect(next).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("never starts queued completions after the owning session ends", async () => {
    const harness = await setup(), fork = Promise.withResolvers<any>(); await harness.append();
    harness.engine.model.fork.mockImplementation(() => fork.promise);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await harness.fire("session.end", { sessionId: "session-a", reason: "other" });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    fork.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("does no model work for an already aborted dispatch", async () => {
    const harness = await setup(); await harness.append(); const abort = new AbortController(); abort.abort();
    const result = nativeResult(), next = Object.assign(vi.fn(async () => result), { signal: abort.signal });
    expect(await harness.fire("session.compact", compact(), next)).toBe(result);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
    expect(harness.posts.filter(post => post.route.endsWith("/arm")).every(post => post.body.record.outcome === "aborted")).toBe(true);
  });
  it("preserves append when its observation cannot read the session identity", async () => {
    const harness = await setup(); harness.engine.session.id.mockRejectedValue(new Error("identity unavailable"));
    await harness.append(); expect(harness.posts).toEqual([]);
  });
  it("captures a boundary before an append has settled while preserving its returned object", async () => {
    const harness = await setup(), stored = Promise.withResolvers<any>();
    const event = { uuid: "before-flush", door: "response", origin: { kind: "model", model: "session-model" }, message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "pending" }] } };
    const pending = harness.fire("session.append", event, vi.fn(() => stored.promise));
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body.boundary_uuid).toBe("before-flush");
    const result = { uuid: event.uuid, message: event.message }; stored.resolve(result); expect(await pending).toBe(result);
  });
});
