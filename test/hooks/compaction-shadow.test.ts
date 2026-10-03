import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { workingHeader } from "../compaction-header/fixtures.js";

const fallbackRequest = vi.hoisted(() => vi.fn(async () => ({
  content: [{ type: "text", text: "paid fallback summary" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn",
})));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: fallbackRequest }; } }));

const SESSION_OUTPUT_CAP = 100;
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
    fs: { write: vi.fn(async () => undefined) }, clock: { after: vi.fn((ms: number, callback: () => void) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) }; }), sleep: vi.fn(() => new Promise(() => {})) }, ui: { log: vi.fn() },
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
    { sessionSummarizerMaxOutputTokens: SESSION_OUTPUT_CAP, ...(enabled === null ? {} : { compactionShadow: enabled }) });
  async function fire(event: string, input: any, next = vi.fn(async (value: any) => value)) {
    const chain = handlers.get(event) ?? [];
    const invoke = (index: number, value: any): any => index === chain.length ? next(value) : chain[index](engine, value, Object.assign((updated: any) => invoke(index + 1, updated), { signal: (next as any).signal }));
    return invoke(0, input);
  }
  async function append(uuid = "boundary") {
    const event = { uuid, door: "response", origin: { kind: "model", model: "session-model" }, message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "In progress" }] } };
    const result = { uuid, message: event.message };
    const next = vi.fn(async () => result); expect(await fire("session.append", event, next)).toBe(result); expect(next).toHaveBeenCalledWith(event);
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
    const harness = await setup(enabled), event = compact(), result = nativeResult(), next = vi.fn(async () => result);
    await harness.append(); expect(await harness.fire("session.compact", event, next)).toBe(result);
    expect(next).toHaveBeenCalledTimes(1); expect(harness.posts).toEqual([]); expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("starts fork before native, preserves input/result identity and pairs every arm with the cut", async () => {
    const harness = await setup(), order: string[] = [], event = compact(), result = nativeResult();
    harness.engine.model.fork.mockImplementation(async () => { order.push("fork"); return { isAnswered: true, text: JSON.stringify(workingHeader()), usage }; });
    await harness.append(); const next = vi.fn(async (input: any) => { order.push("next"); expect(input).toBe(event); return result; });
    expect(await harness.fire("session.compact", event, next)).toBe(result);
    expect(next).toHaveBeenCalledTimes(1); expect(order).toEqual(["fork", "next"]);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    const admission = harness.posts.find(post => post.route.endsWith("/start"))!;
    expect(admission.body).toMatchObject({ boundary_uuid: "boundary", model: "session-model", instructions: event.instructions });
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record).toMatchObject({ text: "  native summary\n", tail: [{ handle: "h2" }], fidelity: "verified" });
    for (const post of harness.posts.filter(post => post.route.endsWith("/arm"))) {
      expect(post.body.cut_id).toBe(admission.body.cut_id);
      expect(post.body.record.usage).toEqual(usage);
      expect(post.body.record.usageAttempts).toEqual([]);
    }
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
  it("cancels queued arms on unload and retains in-flight host outcomes", async () => {
    const harness = await setup(), fork = Promise.withResolvers<any>(); harness.engine.model.fork.mockImplementation(() => fork.promise);
    await harness.append(); await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await harness.fire("session.end", { sessionId: "session-a", reason: "other" });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(2));
    fork.resolve({ isAnswered: false, reason: "aborted", usage });
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
    const { shadowSessionOutputBudget } = await import("../../hooks/shadow-budget.js");
    (await shadowSessionOutputBudget("session-a", SESSION_OUTPUT_CAP).reserveComplete(SESSION_OUTPUT_CAP))!.settle(SESSION_OUTPUT_CAP);
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
  it("preserves a native rejection after an abort without awaiting pairing", async () => {
    const harness = await setup(); await harness.append(); const abort = new AbortController(), original = new Error("native aborted"), fork = Promise.withResolvers<any>();
    harness.engine.model.fork.mockImplementation(() => fork.promise);
    const next = Object.assign(vi.fn(async () => { abort.abort(); fork.resolve({ isAnswered: false, reason: "aborted", usage }); throw original; }), { signal: abort.signal });
    await expect(harness.fire("session.compact", compact(), next)).rejects.toBe(original);
    expect(harness.posts.filter(post => post.route.endsWith("/native"))).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
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
        vi.fn(async (event: any) => ({ uuid: event.uuid, message: event.message })));
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
    const { shadowSessionOutputBudget } = await import("../../hooks/shadow-budget.js"); shadowSessionOutputBudget("session-a", 99);
    expect(await harness.fire("session.compact", compact(), next)).toBe(result); expect(next).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("never starts queued completions after the owning session ends", async () => {
    const harness = await setup(), fork = Promise.withResolvers<any>(); await harness.append();
    harness.engine.model.fork.mockImplementation(() => fork.promise);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    const { shadowSessionOutputBudget, _shadowSessionBudgetIdsForTesting } = await import("../../hooks/shadow-budget.js");
    const budget = shadowSessionOutputBudget("session-a", SESSION_OUTPUT_CAP);
    await harness.fire("session.end", { sessionId: "session-a", reason: "other" });
    expect(_shadowSessionBudgetIdsForTesting()).toEqual(["session-a"]);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(2));
    fork.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(budget.snapshot()).toMatchObject({ spent: usage.output_tokens, usageUnknown: false, reserved: 0 });
    expect(_shadowSessionBudgetIdsForTesting()).toEqual([]);
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("does no admission or model work for an already aborted dispatch", async () => {
    const harness = await setup(); await harness.append(); const abort = new AbortController(); abort.abort();
    const result = nativeResult(), next = Object.assign(vi.fn(async () => result), { signal: abort.signal });
    expect(await harness.fire("session.compact", compact(), next)).toBe(result); expect(next).toHaveBeenCalledTimes(1);
    expect(harness.posts).toEqual([]); expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("preserves append when its observation cannot read the session identity", async () => {
    const harness = await setup(); harness.engine.session.id.mockRejectedValue(new Error("identity unavailable"));
    await harness.append(); expect(harness.posts).toEqual([]);
  });
  it.each(["manual", "auto", "plugin"])("admits each real main-session trigger %s", async trigger => {
    const harness = await setup(); await harness.append();
    await harness.fire("session.compact", { ...compact(), trigger }, vi.fn(async () => nativeResult()));
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body.trigger).toBe(trigger);
  });
  it("retains fork overshoot and refuses the bounded pair without substitution", async () => {
    const harness = await setup(); await harness.append();
    const overspent = { ...usage, output_tokens: 103 };
    harness.engine.model.fork.mockResolvedValue({ isAnswered: true, text: JSON.stringify(workingHeader()), usage: overspent });
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.find(post => post.body.arm === "A")!.body.record).toMatchObject({ usage: overspent, budget: { overshoot: 3 } });
    expect(harness.posts.filter(post => ["B", "C"].includes(post.body.arm)).every(post => post.body.record.outcome === "spend-cap")).toBe(true);
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("keeps pending outcomes bound to their cut across a session change", async () => {
    const harness = await setup(), first = Promise.withResolvers<any>(), second = Promise.withResolvers<any>(); await harness.append("first-boundary");
    harness.engine.model.fork.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    harness.engine.session.id.mockResolvedValue("session-b"); harness.engine.session.cwd.mockResolvedValue("/other"); harness.engine.session.model.mockResolvedValue("second-model");
    await harness.append("second-boundary"); await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    second.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    first.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(6));
    const starts = harness.posts.filter(post => post.route.endsWith("/start"));
    for (const post of harness.posts.filter(post => post.route.endsWith("/arm"))) {
      const admission = starts.find(start => start.body.cut_id === post.body.cut_id)!;
      expect(post.body).toMatchObject({ session_id: admission.body.session_id, cwd: admission.body.cwd });
      if (post.body.arm !== "C") expect(post.body.record.requestedModel).toBe(admission.body.model);
    }
    expect(harness.engine.session.model).toHaveBeenCalledTimes(2);
    expect(harness.engine.model.complete.mock.calls.map(([request]) => request.model)).toEqual(["second-model", "sonnet", "session-model", "sonnet"]);
  });
  it.each(["text", "role", "order", "handle"])("records unverified native tail on changed %s", async field => {
    const harness = await setup(); await harness.append(); const result = nativeResult();
    const mutate: Record<string, () => void> = {
      text: () => { result.messages[1].text = "after-cut text"; }, role: () => { result.messages[1].role = "user"; },
      order: () => { result.messages = [result.messages[0], structuredClone(messages[1]), structuredClone(messages[0])]; },
      handle: () => { result.messages[1].handle = "unknown"; },
    }; mutate[field]();
    expect(await harness.fire("session.compact", compact(), vi.fn(async () => result))).toBe(result);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record.outcome).toBe("unavailable");
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it.each(["denied", "rejected", "subagent", "system"])("keeps the main boundary after an excluded append (%s)", async mode => {
    const harness = await setup(); await harness.append("main-boundary");
    const event = { uuid: "ignored", door: "response", message: { type: "assistant", role: mode === "system" ? undefined : "assistant", content: [{ type: "text", text: "ignored" }] }, ...(mode === "subagent" ? { agentId: "agent" } : {}) };
    const result = mode === "denied" ? { deny: "blocked" } : { uuid: event.uuid, message: event.message };
    const next = vi.fn(async () => { if (mode === "rejected") throw new Error("append rejected"); return result; });
    if (mode === "rejected") await expect(harness.fire("session.append", event, next)).rejects.toThrow("append rejected");
    else expect(await harness.fire("session.append", event, next)).toBe(result);
    expect(next).toHaveBeenCalledTimes(1);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body.boundary_uuid).toBe("main-boundary");
  });
  it("calls a worker's throwing native continuation only once", async () => {
    const harness = await setup(); harness.engine.env.get.mockResolvedValue("1");
    const error = new Error("native failed"), next = vi.fn(() => { throw error; });
    await expect(harness.fire("session.compact", compact(), next)).rejects.toBe(error);
    expect(next).toHaveBeenCalledTimes(1); expect(harness.posts).toEqual([]);
  });
  it("owns dispatch abort through the awaited native pairing write", async () => {
    const harness = await setup(), abort = new AbortController(), fork = Promise.withResolvers<any>(); await harness.append();
    harness.engine.model.fork.mockImplementation(() => fork.promise);
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) => { if (url.endsWith("/native")) { abort.abort(); fork.resolve({ isAnswered: false, reason: "aborted", usage }); } return fetch(url, init); });
    const result = nativeResult(), next = Object.assign(vi.fn(async () => result), { signal: abort.signal });
    expect(await harness.fire("session.compact", compact(), next)).toBe(result);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.filter(post => post.route.endsWith("/arm")).every(post => post.body.record.outcome === "aborted")).toBe(true);
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("preserves late host usage from a fork after session end", async () => {
    const harness = await setup(), fork = Promise.withResolvers<any>(); await harness.append();
    harness.engine.model.fork.mockImplementation(() => fork.promise);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await harness.fire("session.end", { sessionId: "session-a", reason: "other" });
    fork.resolve({ isAnswered: false, reason: "aborted", usage });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.find(post => post.body.arm === "A")!.body.record).toMatchObject({ outcome: "aborted", usage });
  });
  it("preserves usage from completions already in flight at session end", async () => {
    const harness = await setup(), complete = Promise.withResolvers<any>(); await harness.append();
    harness.engine.model.complete.mockImplementation(() => complete.promise);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.engine.model.complete).toHaveBeenCalledTimes(2));
    await harness.fire("session.end", { sessionId: "session-a", reason: "other" });
    complete.resolve({ isAnswered: false, reason: "aborted", usage });
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    for (const arm of ["B", "C"]) expect(harness.posts.find(post => post.body.arm === arm)!.body.record).toMatchObject({ outcome: "aborted", usage });
  });
  it("freezes the observed boundary before host identity reads settle", async () => {
    const harness = await setup(), identity = Promise.withResolvers<string>(); await harness.append("at-entry");
    harness.engine.session.id.mockReturnValueOnce(identity.promise);
    const pending = harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await harness.append("after-entry"); identity.resolve("session-a"); await pending;
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body.boundary_uuid).toBe("at-entry");
  });
  it("does not start models when clear ends the cut during admission", async () => {
    const harness = await setup(), gate = Promise.withResolvers<void>(); await harness.append();
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) => { const response = await fetch(url, init); if (url.endsWith("/start")) await gate.promise; return response; });
    const result = nativeResult(), next = vi.fn(async () => result), pending = harness.fire("session.compact", compact(), next);
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/start"))).toHaveLength(1));
    await harness.fire("classic.SessionStart", { session_id: "session-a", source: "clear" }); gate.resolve();
    expect(await pending).toBe(result); expect(next).toHaveBeenCalledTimes(1);
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it.each(["summary", "tail", "handles"])("retains known native accounting when %s extraction is ambiguous", async ambiguity => {
    const harness = await setup(); await harness.append(); const event = compact();
    const result = { ...nativeResult(), tokensBefore: 8905, tokensAfter: 222 };
    if (ambiguity === "summary") result.messages.unshift({ ...result.messages[0], text: "another summary" });
    if (ambiguity === "tail") result.messages[1].text = "unverified tail";
    if (ambiguity === "handles") event.messages[1].handle = event.messages[0].handle;
    expect(await harness.fire("session.compact", event, vi.fn(async () => result))).toBe(result);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record).toMatchObject({ outcome: "unavailable", usage, tokensBefore: 8905, tokensAfter: 222 });
  });
  it("retains the last stored boundary when overlapping appends A and B are denied", async () => {
    const harness = await setup(); await harness.append("stored");
    const first = Promise.withResolvers<any>(), second = Promise.withResolvers<any>();
    const row = (uuid: string) => ({ uuid, door: "response", message: { type: "assistant", role: "assistant", content: [{ type: "text", text: uuid }] } });
    const firstNext = vi.fn(() => first.promise), secondNext = vi.fn(() => second.promise);
    const pendingFirst = harness.fire("session.append", row("rejected-A"), firstNext);
    await vi.waitFor(() => expect(firstNext).toHaveBeenCalledTimes(1));
    const pendingSecond = harness.fire("session.append", row("rejected-B"), secondNext);
    await vi.waitFor(() => expect(secondNext).toHaveBeenCalledTimes(1));
    first.resolve({ deny: "blocked" }); await pendingFirst;
    second.resolve({ deny: "blocked" }); await pendingSecond;
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body.boundary_uuid).toBe("stored");
  });
  it.each(["identity", "cwd", "model", "worker", "host-env", "http"])("runs native once at the fixed admission deadline after a hung %s", async prerequisite => {
    vi.useFakeTimers();
    try {
      const harness = await setup(); await harness.append(); const never = new Promise<any>(() => {});
      if (prerequisite === "identity") harness.engine.session.id.mockReturnValue(never);
      if (prerequisite === "cwd") harness.engine.session.cwd.mockReturnValue(never);
      if (prerequisite === "model") harness.engine.session.model.mockReturnValue(never);
      if (prerequisite === "worker") harness.engine.env.get.mockReturnValue(never);
      if (prerequisite === "host-env") harness.engine.process.run.mockReturnValue(never);
      if (prerequisite === "http") harness.engine.http.fetch.mockReturnValue(never);
      const result = nativeResult(), next = vi.fn(async () => result), pending = harness.fire("session.compact", compact(), next);
      await vi.advanceTimersByTimeAsync(1999); expect(next).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(next).toHaveBeenCalledTimes(1); expect(await pending).toBe(result);
      expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
      expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("does not start a shadow HTTP stage when host environment discovery finishes after expiry", async () => {
    vi.useFakeTimers();
    try {
      const harness = await setup(); await harness.append(); const late = Promise.withResolvers<any>();
      harness.engine.process.run.mockReturnValue(late.promise);
      const result = nativeResult(), next = vi.fn(async () => result), pending = harness.fire("session.compact", compact(), next);
      await vi.advanceTimersByTimeAsync(2000); expect(await pending).toBe(result); expect(next).toHaveBeenCalledTimes(1);
      late.resolve({ stdout: "secret\n__CONFIG__\n{}\n__TMPDIR__/tmp", exitCode: 0 }); await vi.advanceTimersByTimeAsync(0);
      expect(harness.engine.http.fetch).not.toHaveBeenCalled(); expect(harness.engine.model.fork).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("returns native identity at the pairing deadline without starting B or C", async () => {
    vi.useFakeTimers();
    try {
      const harness = await setup(); await harness.append(); const fetch = harness.engine.http.fetch.getMockImplementation()!, late = Promise.withResolvers<any>();
      harness.engine.http.fetch.mockImplementation((url, init) => url.endsWith("/native") ? late.promise : fetch(url, init));
      const result = nativeResult(), next = vi.fn(async () => result), pending = harness.fire("session.compact", compact(), next);
      await vi.advanceTimersByTimeAsync(1999); expect(next).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe(result); expect(harness.engine.model.complete).not.toHaveBeenCalled();
      late.resolve({ ok: true, status: 200, text: JSON.stringify({ stored: true, job }) }); await vi.advanceTimersByTimeAsync(0);
      expect(harness.engine.model.complete).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("races a hung admission read with dispatch abort", async () => {
    const harness = await setup(); await harness.append(); harness.engine.session.model.mockReturnValue(new Promise<any>(() => {}));
    const abort = new AbortController(), result = nativeResult(), next = Object.assign(vi.fn(async () => result), { signal: abort.signal });
    const pending = harness.fire("session.compact", compact(), next); abort.abort();
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1)); expect(await pending).toBe(result);
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("starts no arm when clear lands between the admission epoch check and return", async () => {
    const harness = await setup(), order: string[] = []; await harness.append();
    harness.engine.model.fork.mockImplementation(async () => { order.push("fork"); return { isAnswered: true, text: JSON.stringify(workingHeader()), usage }; });
    harness.engine.model.complete.mockImplementation(async request => { order.push(request.model === "sonnet" ? "C" : "B"); return { isAnswered: true, text: JSON.stringify(workingHeader()), usage }; });
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    let cleared: Promise<any> | undefined;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      const response = await fetch(url, init);
      if (!url.endsWith("/start")) return response;
      return { ...response, get text() {
        queueMicrotask(() => queueMicrotask(() => { order.push("clear"); cleared = harness.fire("classic.SessionStart", { session_id: "session-a", source: "clear" }); }));
        return response.text;
      } };
    });
    const result = nativeResult(), next = vi.fn(async () => { order.push("next"); return result; });
    expect(await harness.fire("session.compact", compact(), next)).toBe(result); await cleared;
    expect(order).toEqual(["clear", "next"]); expect(next).toHaveBeenCalledTimes(1);
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
    expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toEqual([]);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body.record.shadowAdmission).toBe("cancelled");
  });
  it("keeps ordinary summaries on their configured session provider after unreported shadow fork usage", async () => {
    const harness = await setup(); await harness.append(); fallbackRequest.mockClear();
    harness.engine.process.run.mockResolvedValue({ stdout: 'secret\n__CONFIG__\n{"llm":{"provider":"session","fallbackProvider":"anthropic"}}\n__TMPDIR__/tmp', exitCode: 0 });
    harness.engine.model.fork.mockRejectedValue(new Error("unreported shadow failure"));
    const { SummarizeJobStore } = await import("../../src/daemon/summarize-jobs.js");
    const { createSummarizer } = await import("../../src/daemon/summarizer.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const jobs = new SummarizeJobStore(), config = loadDaemonConfig("/missing", { llm: { provider: "session", fallbackProvider: "anthropic", apiKey: "test-only", model: "fallback-model" }, summarizer: { language: "en" } }, {});
    const summarizer = (await createSummarizer("session", config, jobs))!;
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    let polled = false;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      if (url.includes("/summarize-jobs/next")) {
        if (polled) return new Promise<any>(() => {});
        polled = true;
        return { ok: true, status: 200, text: JSON.stringify({ job: await jobs.next("session-a", undefined, false) }) };
      }
      const response = await fetch(url, init);
      if (url.includes("/summarize-jobs/") && init?.method === "POST") jobs.answer(new URL(url).pathname.split("/").at(-1)!, JSON.parse(init.body));
      return response;
    });
    harness.engine.model.complete.mockImplementation(async () => ({ isAnswered: true, text: "ordinary summary", usage }));
    try {
      await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
      await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
      const reported: string[] = [], ordinary = summarizer("ordinary request", false, { sessionId: "session-a", targetTokens: 10, onUsage: row => reported.push(row.provider) });
      await harness.fire("session.start", {});
      expect(await ordinary).toBe("ordinary summary"); expect(reported).toEqual(["session:haiku"]); expect(fallbackRequest).not.toHaveBeenCalled();
      expect(harness.engine.model.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "haiku", maxTokens: SESSION_OUTPUT_CAP }));
    } finally { jobs.close(); }
  });
  it("records unknown shadow usage and refuses all later arms in that session with a reason", async () => {
    const harness = await setup(); await harness.append(); harness.engine.model.fork.mockRejectedValue(new Error("unreported"));
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.find(post => post.body.arm === "A")!.body.record).toMatchObject({ usageUnknown: true });
    await harness.append("next-cut"); await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(6));
    const secondCut = harness.posts.filter(post => post.route.endsWith("/start"))[1].body.cut_id;
    for (const post of harness.posts.filter(post => post.route.endsWith("/arm") && post.body.cut_id === secondCut))
      expect(post.body.record).toMatchObject({ outcome: "spend-cap", refusalReason: "usageUnknown" });
    expect(harness.engine.model.fork).toHaveBeenCalledTimes(1); expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });
  it("cancels an old session's pending cut when clear changes the current session id", async () => {
    const harness = await setup(), gate = Promise.withResolvers<void>(); await harness.append();
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      const response = await fetch(url, init); if (url.endsWith("/start")) await gate.promise; return response;
    });
    const result = nativeResult(), next = vi.fn(async () => result), pending = harness.fire("session.compact", compact(), next);
    await vi.waitFor(() => expect(harness.posts.some(post => post.route.endsWith("/start"))).toBe(true));
    harness.engine.session.id.mockResolvedValue("session-b");
    await harness.fire("session.end", { sessionId: "session-a", reason: "clear" });
    await harness.fire("classic.SessionStart", { session_id: "session-b", source: "clear" }); gate.resolve();
    expect(await pending).toBe(result); expect(next).toHaveBeenCalledTimes(1);
    expect(harness.engine.model.fork).not.toHaveBeenCalled(); expect(harness.engine.model.complete).not.toHaveBeenCalled();
    expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toEqual([]);
    expect(harness.posts.find(post => post.route.endsWith("/native"))!.body).toMatchObject({ session_id: "session-a", record: { shadowAdmission: "cancelled" } });
  });
  it("refuses shadow work after a bounded unknown completion even when nominal allowance remains", async () => {
    const harness = await setup(); await harness.append(); harness.engine.model.complete.mockRejectedValueOnce(new Error("unreported B"));
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(3));
    expect(harness.posts.find(post => post.body.arm === "B")!.body.record).toMatchObject({ usageUnknown: true, budget: { available: 1 } });
    await harness.append("later"); await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    await vi.waitFor(() => expect(harness.posts.filter(post => post.route.endsWith("/arm"))).toHaveLength(6));
    const lastCut = harness.posts.filter(post => post.route.endsWith("/start")).at(-1)!.body.cut_id;
    expect(harness.posts.filter(post => post.route.endsWith("/arm") && post.body.cut_id === lastCut).every(post => post.body.record.refusalReason === "usageUnknown")).toBe(true);
    expect(harness.engine.model.fork).toHaveBeenCalledTimes(1); expect(harness.engine.model.complete).toHaveBeenCalledTimes(2);
  });
  it("uses only stored boundaries while an append is pending and preserves its returned object", async () => {
    const harness = await setup(), stored = Promise.withResolvers<any>(); await harness.append("last-stored");
    const event = { uuid: "before-flush", door: "response", origin: { kind: "model", model: "session-model" }, message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "pending" }] } };
    const enteredCore = Promise.withResolvers<void>();
    const pending = harness.fire("session.append", event, vi.fn(() => { enteredCore.resolve(); return stored.promise; }));
    await enteredCore.promise;
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    expect(harness.posts.find(post => post.route.endsWith("/start"))!.body.boundary_uuid).toBe("last-stored");
    const result = { uuid: event.uuid, message: event.message }; stored.resolve(result); expect(await pending).toBe(result);
    await harness.fire("session.compact", compact(), vi.fn(async () => nativeResult()));
    expect(harness.posts.filter(post => post.route.endsWith("/start")).at(-1)!.body.boundary_uuid).toBe("before-flush");
  });
});
