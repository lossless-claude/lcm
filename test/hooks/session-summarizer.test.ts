import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_WARNING } from "../../src/worker-warning.js";

const sessionId = "session/one";
const leaf = { id: "job-1", session_id: sessionId, kind: "leaf", system: "system", prompt: "prompt", maxTokens: 1024 };

async function start(options: Record<string, number> = {}, jobs: unknown[] = [leaf], env: Record<string, string> = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const posts: { url: string; body: Record<string, any> }[] = [];
  // The poller's one-minute wait after a 404 is parked here instead of firing: the harness
  // answers 404 when its jobs run out, and a test decides whether the poller wakes again.
  const retries: (() => void)[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const engine = {
    env: { get: vi.fn(async (name: string) => env[name]) },
    session: { id: vi.fn(async () => sessionId), cwd: vi.fn(async () => "/proj") },
    process: { run: vi.fn(async () => ({ stdout: "secret\n__CONFIG__\n{}\n__TMPDIR__/tmp", exitCode: 0 })) },
    fs: { write: vi.fn(async () => undefined) },
    model: {
      complete: vi.fn(async (): Promise<unknown> => "  summary  "),
      fork: vi.fn(async (): Promise<unknown> => null),
    },
    clock: {
      after: vi.fn((ms: number, callback: () => void) => { if (ms >= 60_000) retries.push(callback); else callback(); }),
      sleep: vi.fn(() => new Promise<void>(() => {})),
    },
    ui: { log: vi.fn() },
    http: { fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) =>
      init?.method === "POST" ? summaryPost(url, JSON.parse(init.body!), { posts, finish }) : summaryGet(url, { jobs, finish })) },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, options);
  const trigger = () => handlers.get("session.start")!(engine, {}, vi.fn((event) => event));
  return { engine, posts, done, trigger, retries, jobs, handlers };
}

function summaryPost(url: string, body: Record<string, any>, { posts, finish }: { posts: { url: string; body: Record<string, any> }[]; finish: () => void }) {
  if (url.endsWith("/worker-session") && body.action === "check") return { ok: true, status: 200, text: JSON.stringify({ enrolled: true, warning: WORKER_WARNING }) };
  if (url.includes("/summarize-jobs/")) posts.push({ url, body });
  if (body.error === "spend cap") finish();
  return { ok: true, status: 200, text: "{}" };
}
function summaryGet(url: string, { jobs, finish }: { jobs: unknown[]; finish: () => void }) {
  if (url.endsWith("/health")) return { ok: true, status: 200, text: "{}" };
  if (!jobs.length) { finish(); return { ok: false, status: 404, text: "" }; }
  const job = jobs.shift();
  if (job instanceof Error) throw job;
  if (job === "unauthorized") return { ok: false, status: 401, text: "" };
  if (job === "malformed") return { ok: true, status: 200, text: "not json" };
  return { ok: true, status: 200, text: JSON.stringify({ job }) };
}

describe("function-hook session summarizer", () => {
  beforeEach(() => vi.resetModules());

  it("charges an unreported failed completion at its full reservation alongside a concurrent header lease", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 12 }, [{ ...leaf, maxTokens: 4 }]);
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    const budget = sharedSessionOutputBudget(sessionId, 12);
    let headerLease: Awaited<ReturnType<typeof budget.reserveComplete>>;
    harness.engine.model.complete.mockImplementation(async () => {
      headerLease = await budget.reserveComplete(3); throw new Error("connection dropped");
    });
    await harness.trigger(); await harness.done;
    expect(budget.snapshot()).toMatchObject({ spent: 4, reserved: 3, available: 5, usageUnknown: true });
    headerLease!.settle(1);
    expect((await budget.reserveComplete(100))!.maxTokens).toBe(7);
  });
  it("does not mistake known prior fork usage for the usage of a failed fallback", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 12 }, [{ ...leaf, kind: "condensed", maxTokens: 4 }]);
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    const budget = sharedSessionOutputBudget(sessionId, 12);
    harness.engine.model.fork.mockResolvedValue({ isAnswered: false, reason: "api-error", usage: { input_tokens: 1, output_tokens: 1 } });
    harness.engine.model.complete.mockRejectedValue(new Error("connection dropped"));
    await harness.trigger(); await harness.done;
    expect(budget.snapshot()).toMatchObject({ spent: 12, available: 0, usageUnknown: true });
  });

  it("uses a stable module owner even when the header and poller receive different dispatch facades", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 5 });
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    const budget = sharedSessionOutputBudget(sessionId, 5);
    (await budget.reserveComplete(4))!.settle(4);
    harness.engine.model.complete.mockResolvedValue({ isAnswered: true, text: "ok", usage: { input_tokens: 1, output_tokens: 1 } });
    await harness.trigger(); await harness.done;
    expect(harness.engine.model.complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1 }));
    expect(budget.snapshot().spent).toBe(5);
  });

  it("shares the session output budget with header work instead of resetting it at poller start", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 5 });
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    const budget = sharedSessionOutputBudget(sessionId, 5);
    (await budget.reserveComplete(4))!.settle(4);
    harness.engine.model.complete.mockResolvedValue({ isAnswered: true, text: "ok", usage: { input_tokens: 1, output_tokens: 1 } });
    await harness.trigger(); await harness.done;
    expect(harness.engine.model.complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1 }));
    expect(budget.snapshot().spent).toBe(5);
  });
  it("charges unsuccessful ordinary output to the shared owner", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 5 });
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    const budget = sharedSessionOutputBudget(sessionId, 5);
    harness.engine.model.complete.mockResolvedValue({ isAnswered: false, reason: "api-error", usage: { input_tokens: 1, output_tokens: 3 } });
    await harness.trigger(); await harness.done;
    expect(budget.snapshot().spent).toBe(3);
  });
  it("records ordinary fork overshoot even when the answer is refused", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 5 }, [{ ...leaf, kind: "condensed" }]);
    const { sharedSessionOutputBudget } = await import("../../hooks/model-budget.js");
    const budget = sharedSessionOutputBudget(sessionId, 5);
    harness.engine.model.fork.mockResolvedValue({ isAnswered: false, reason: "api-error", usage: { input_tokens: 2, output_tokens: 8 } });
    await harness.trigger(); await harness.done;
    expect(budget.snapshot()).toMatchObject({ spent: 8, overshoot: 3 });
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
  });

  it("warns about exclusion only after confirmed command-hook enrollment", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 }, [], { LCM_SUMMARIZE_WORKER: "1" });
    await harness.trigger();
    expect(harness.engine.ui.log).toHaveBeenCalledWith(`[lcm] ${WORKER_WARNING}`);
    expect(harness.engine.http.fetch.mock.calls.filter(([url]) => url.endsWith("/worker-session")))
      .toEqual([[expect.any(String), expect.objectContaining({ body: JSON.stringify({
        session_id: sessionId, cwd: "/proj", client: "claude", declared: true, action: "check",
      }) })]]);
  });

  it.each([
    { ok: true, status: 200, text: JSON.stringify({ enrolled: false, reason: "No command-hook enrollment was found" }) },
    { ok: false, status: 404, text: "" },
  ])("reports refused worker mode without promising exclusion when enrollment is unconfirmed: %j", async response => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 4 }, [{ ...leaf, pool: true }], { LCM_SUMMARIZE_WORKER: "1" });
    harness.engine.clock.after.mockImplementation((ms, callback) => {
      if (ms === 5_000) harness.retries.push(callback);
      else callback();
    });
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) => url.endsWith("/worker-session") ? response : fetch(url, init));
    await harness.trigger();
    expect(harness.engine.ui.log.mock.calls.flat().join("\n")).not.toContain("not recorded by lcm");
    expect(harness.engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("worker mode refused"));
    expect(harness.engine.ui.log).toHaveBeenCalledWith(expect.stringContaining(response.ok
      ? "No command-hook enrollment was found" : "enrollment could not be confirmed"));
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
    expect(harness.engine.http.fetch.mock.calls.some(([url]) => url.includes("/summarize-jobs/next"))).toBe(false);
    await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    expect(harness.engine.http.fetch.mock.calls.some(([url]) => url.endsWith("/ingest"))).toBe(true);
    const checks = harness.engine.http.fetch.mock.calls.filter(([url]) => url.endsWith("/worker-session"));
    expect(checks.length).toBeGreaterThan(1);
    const delays = harness.engine.clock.after.mock.calls.map(([ms]) => ms).filter(ms => ms < 5_000);
    expect(delays.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(30_000);
    expect(harness.retries).toHaveLength(1);
  });

  it("starts a worker when command-hook enrollment arrives after the first check", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 4 }, [{ ...leaf, pool: true }], { LCM_SUMMARIZE_WORKER: "1" });
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    let checks = 0;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/worker-session") && ++checks === 1) return { ok: true, status: 200,
        text: JSON.stringify({ enrolled: false, reason: "No command-hook enrollment was found" }) };
      return fetch(url, init);
    });
    harness.engine.model.complete.mockResolvedValue({ isAnswered: true, text: "summary", usage: { input_tokens: 9, output_tokens: 4 } });
    await harness.trigger();
    await vi.waitFor(() => expect(harness.posts).toHaveLength(1), { timeout: 200 });
    expect(checks).toBe(2);
    expect(harness.engine.clock.after).toHaveBeenCalledWith(expect.any(Number), expect.any(Function));
    expect(harness.engine.ui.log).toHaveBeenCalledWith(`[lcm] ${WORKER_WARNING}`);
    expect(harness.engine.ui.log.mock.calls.flat().join("\n")).not.toContain("worker mode refused");
  });

  it("keeps retrying enrollment for ten workers after the startup wait ends", async () => {
    const workers = [];
    let enrolled = false;
    for (let i = 0; i < 10; i++) {
      vi.resetModules();
      const harness = await start({ sessionSummarizerMaxOutputTokens: 4 }, [{ ...leaf, pool: true }], {
        LCM_SUMMARIZE_WORKER: "1",
      });
      const fetch = harness.engine.http.fetch.getMockImplementation()!;
      harness.engine.http.fetch.mockImplementation(async (url, init) => url.endsWith("/worker-session") && !enrolled
        ? { ok: true, status: 200, text: JSON.stringify({ enrolled: false, reason: "command hook still registering" }) }
        : fetch(url, init));
      const after = harness.engine.clock.after.getMockImplementation()!;
      harness.engine.clock.after.mockImplementation((ms, callback) => {
        if (ms === 5_000 && !enrolled) harness.retries.push(callback);
        else after(ms, callback);
      });
      harness.engine.model.complete.mockResolvedValue({
        isAnswered: true, text: "summary", usage: { input_tokens: 9, output_tokens: 4 },
      });
      workers.push(harness);
    }
    await Promise.all(workers.map(worker => worker.trigger()));
    for (const worker of workers) {
      expect(worker.engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("command hook still registering"));
      expect(worker.retries).toHaveLength(1);
      expect(worker.posts).toHaveLength(0);
    }
    enrolled = true;
    workers.forEach(worker => worker.retries[0]());
    await vi.waitFor(() => expect(workers.map(worker => worker.posts.length)).toEqual(Array(10).fill(1)));
  });

  it("serves foreign pool jobs with complete only and stops polling at the worker cap", async () => {
    const foreign = { ...leaf, pool: true, session_id: "closed-session", kind: "condensed" };
    const harness = await start({ sessionSummarizerMaxOutputTokens: 4 }, [foreign, foreign], {
      LCM_SUMMARIZE_WORKER: "1", LCM_SUMMARIZE_WORKER_MODEL: "sonnet",
    });
    harness.engine.model.complete.mockResolvedValue({ isAnswered: true, text: "summary", usage: { input_tokens: 9, output_tokens: 4 } });
    await harness.trigger();
    await vi.waitFor(() => expect(harness.posts).toHaveLength(1));
    expect(harness.engine.model.complete).toHaveBeenCalledExactlyOnceWith({ model: "sonnet", system: "system", prompt: "prompt", maxTokens: 4 });
    expect(harness.engine.model.fork).not.toHaveBeenCalled();
    expect(harness.posts[0].body.providerId).toBe("session-pool:sonnet");
    expect(harness.jobs).toHaveLength(1);
    const polls = harness.engine.http.fetch.mock.calls.filter(([url]) => url.includes("/summarize-jobs/next"));
    expect(polls).toHaveLength(1);
    expect(polls[0][0]).toContain("worker_id=session%2Fone");
    const snapshots = harness.engine.fs.write.mock.calls.filter(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(snapshots.every(([, body]) => JSON.parse(body).sessionId === sessionId)).toBe(true);
  });

  it("treats a worker 200 without a job as an empty poll", async () => {
    const harness = await start({}, [undefined, { ...leaf, pool: true, session_id: "foreign" }], {
      LCM_SUMMARIZE_WORKER: "1",
    });
    await harness.trigger();
    await harness.done;
    expect(harness.engine.model.complete).toHaveBeenCalledOnce();
    expect(harness.posts).toHaveLength(1);
    expect(harness.engine.ui.log.mock.calls.flat().join("\n")).not.toContain("discarded summary job");
  });

  it("lets an explicit worker cap override a disabled normal-session summarizer", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 }, [{ ...leaf, pool: true }], {
      LCM_SUMMARIZE_WORKER: "1", LCM_SUMMARIZE_WORKER_MAX_OUTPUT_TOKENS: "4",
    });
    harness.engine.model.complete.mockResolvedValue({ isAnswered: true, text: "summary", usage: { input_tokens: 9, output_tokens: 4 } });
    await harness.trigger();
    await vi.waitFor(() => expect(harness.posts).toHaveLength(1));
    expect(harness.engine.model.complete).toHaveBeenCalledExactlyOnceWith({ model: "haiku", system: "system", prompt: "prompt", maxTokens: 4 });
  });

  it("stops a worker when a failed completion consumes its remaining allowance", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 4 }, [{ ...leaf, pool: true }, { ...leaf, pool: true }], {
      LCM_SUMMARIZE_WORKER: "1",
    });
    harness.engine.model.complete.mockResolvedValue({ isAnswered: false, reason: "empty-reply", usage: { input_tokens: 9, output_tokens: 4 } });
    await harness.trigger();
    await vi.waitFor(() => expect(harness.posts).toHaveLength(1));
    expect(harness.posts[0].body).toMatchObject({ error: "empty-reply", usageAttempts: [{ providerId: "session-pool:haiku", failed: true }] });
    expect(harness.engine.model.complete).toHaveBeenCalledOnce();
    expect(harness.engine.model.fork).not.toHaveBeenCalled();
    expect(harness.jobs).toHaveLength(1);
  });

  it("claims the session but starts no poller when the summarizer is disabled", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    expect(await harness.trigger()).toEqual({});
    expect(harness.engine.fs.write).toHaveBeenCalledWith(
      "/tmp/lcm-claim-session%2Fone.json",
      expect.stringContaining(`"sessionId":"${sessionId}"`),
    );
    expect(harness.engine.model.complete).not.toHaveBeenCalled();
    const snapshotWrite = harness.engine.fs.write.mock.calls.find(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(snapshotWrite).toBeDefined();
    expect(JSON.parse(snapshotWrite![1])).toMatchObject({
      harness: "claude-function", sessionId, observations: [
        { hook: "session.start", operation: "claim", kind: "execution", status: "completed", count: 1 },
      ],
    });
  });

  it("does not create a snapshot without a usable session id", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    harness.engine.session.id.mockResolvedValue("");
    await expect(harness.trigger()).resolves.toEqual({});
    expect(harness.engine.fs.write.mock.calls.some(([path]) => String(path).includes("lcm-hook-observe-")))
      .toBe(false);
  });

  it("uses distinct claim and snapshot files for colliding sanitized IDs", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    harness.engine.session.id.mockResolvedValueOnce("a/b").mockResolvedValueOnce("a_b");
    await harness.trigger();
    await harness.trigger();
    const paths = harness.engine.fs.write.mock.calls.map(([path]) => String(path));
    expect(paths).toContain("/tmp/lcm-claim-a%2Fb.json");
    expect(paths).toContain("/tmp/lcm-claim-a%5Fb.json");
    expect(paths.some((path) => path.includes("lcm-hook-observe-a%2Fb-"))).toBe(true);
    expect(paths.some((path) => path.includes("lcm-hook-observe-a%5Fb-"))).toBe(true);
  });

  it("flushes turn outcomes into the bounded local snapshot", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    await harness.trigger();
    await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    const snapshots = harness.engine.fs.write.mock.calls
      .filter(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(snapshots).toHaveLength(2);
    expect(JSON.parse(snapshots[1][1]).observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ hook: "turn.complete", operation: "capture", kind: "delivery", status: "accepted" }),
      expect.objectContaining({ hook: "turn.complete", operation: "promote-events", kind: "delivery", status: "accepted" }),
    ]));
  });

  it("keeps session start fail-open when snapshot preparation throws", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    harness.engine.session.cwd.mockImplementationOnce(() => { throw new Error("cwd unavailable"); });
    await expect(harness.trigger()).resolves.toEqual({});
    expect(harness.engine.ui.log).not.toHaveBeenCalled();
  });

  it("bounds a slow diagnostic write that later succeeds without reporting a failure", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    harness.engine.clock.sleep.mockResolvedValue(undefined);
    const blocked = Promise.withResolvers<void>();
    let snapshotWrites = 0;
    harness.engine.fs.write.mockImplementation((path: string) => {
      if (!path.includes("lcm-hook-observe-")) return Promise.resolve();
      return ++snapshotWrites === 1 ? blocked.promise : Promise.resolve();
    });
    await expect(harness.trigger()).resolves.toEqual({});
    expect(harness.engine.ui.log).not.toHaveBeenCalled();
    for (let turn = 0; turn < 20; turn++) {
      await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    }
    expect(harness.engine.fs.write.mock.calls.filter(([path]) => String(path).includes("lcm-hook-observe-")))
      .toHaveLength(1);
    blocked.resolve();
    await blocked.promise;
    await Promise.resolve();
    await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    expect(snapshotWrites).toBe(2);
    expect(harness.engine.clock.sleep).toHaveBeenCalledWith(250);
    expect(harness.engine.ui.log).not.toHaveBeenCalled();
  });

  it.each(["rejected", "late rejection", "thrown"])("reports a %s snapshot write once per session", async (failure) => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    const blocked = Promise.withResolvers<void>();
    if (failure === "late rejection") harness.engine.clock.sleep.mockResolvedValue(undefined);
    let snapshotWrites = 0;
    harness.engine.fs.write.mockImplementation((path: string) => {
      if (!path.includes("lcm-hook-observe-")) return Promise.resolve();
      snapshotWrites++;
      if (failure === "thrown") throw new Error("read-only fs");
      return failure === "late rejection" && snapshotWrites === 1
        ? blocked.promise : Promise.reject(new Error("read-only fs"));
    });
    await expect(harness.trigger()).resolves.toEqual({});
    if (failure === "late rejection") {
      expect(harness.engine.ui.log).not.toHaveBeenCalled();
      blocked.reject(new Error("read-only fs"));
    }
    await vi.waitFor(() => expect(harness.engine.ui.log).toHaveBeenCalledExactlyOnceWith(
      "[lcm] hook observation snapshot could not be written",
    ));
    await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    expect(snapshotWrites).toBe(2);
    expect(harness.engine.ui.log).toHaveBeenCalledTimes(1);
  });

  it("does not report a snapshot write failure when the wait throws", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    harness.engine.clock.sleep.mockImplementation((ms: number) => {
      if (ms === 250) throw new Error("clock unavailable");
      return new Promise<void>(() => {});
    });
    await expect(harness.trigger()).resolves.toEqual({});
    expect(harness.engine.ui.log).not.toHaveBeenCalled();
  });

  it("records an HTTP rejection as rejected with its status", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    await harness.trigger();
    const originalFetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) =>
      url.endsWith("/ingest") ? { ok: false, status: 401, text: "" } : originalFetch(url, init));
    await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    const snapshots = harness.engine.fs.write.mock.calls
      .filter(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(JSON.parse(snapshots.at(-1)![1]).observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ hook: "turn.complete", operation: "capture", kind: "delivery",
        status: "rejected", reason: "http-401" }),
    ]));
  });

  it("records accepted delivery and completed execution for restore and search", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    await harness.trigger();
    await harness.handlers.get("prompt.context")!(harness.engine, { blocks: [] }, vi.fn(async (event) => event));
    await harness.handlers.get("prompt.submit")!(harness.engine, { text: "find memory" }, vi.fn(async (event) => event));
    await harness.handlers.get("turn.complete")!(harness.engine, {}, vi.fn((event) => event));
    const snapshots = harness.engine.fs.write.mock.calls
      .filter(([path]) => String(path).includes("lcm-hook-observe-"));
    const observations = JSON.parse(snapshots.at(-1)![1]).observations;
    for (const [hook, operation] of [["prompt.context", "restore"], ["prompt.submit", "search"]]) {
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ hook, operation, kind: "delivery", status: "accepted" }),
        expect.objectContaining({ hook, operation, kind: "execution", status: "completed" }),
      ]));
    }
  });

  it("lets session.start finish when the claim cannot be written", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    harness.engine.fs.write.mockRejectedValueOnce(new Error("read-only fs"));
    expect(await harness.trigger()).toEqual({});
    expect(harness.engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("could not claim the session"));
  });

  it("starts one poller, uses the session bearer, and reports estimated Haiku usage", async () => {
    const { trigger, done, engine, posts } = await start();
    await trigger();
    await trigger();
    await done;
    // Two session.start calls claim the session twice; only the first starts a poller.
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
    expect(engine.http.fetch).toHaveBeenCalledWith(
      expect.stringContaining("session_id=session%2Fone"),
      { headers: { authorization: "Bearer secret" } },
    );
    expect(engine.model.complete).toHaveBeenCalledWith({ model: "haiku", system: "system", prompt: "prompt", maxTokens: 1024 });
    expect(posts[0].body).toEqual({ text: "summary", providerId: "session:haiku", usage: { input_tokens: 3, output_tokens: 2, estimated: true } });
  });

  // /clear, /resume and /branch continue under a new session id with no session.start.
  it("polls for the current session id after it changes without session.start", async () => {
    const harness = await start();
    harness.engine.model.complete.mockImplementation(async () => {
      harness.engine.session.id.mockResolvedValue("session/two");
      return "summary";
    });
    await harness.trigger();
    await harness.done;
    const polls = harness.engine.http.fetch.mock.calls
      .map(([url]) => String(url)).filter((url) => url.includes("/summarize-jobs/next"));
    expect(polls[0]).toContain("session_id=session%2Fone");
    expect(polls.at(-1)).toContain("session_id=session%2Ftwo");
  });

  it("retains accepted delivery for a summary answer", async () => {
    const harness = await start();
    await harness.trigger();
    await harness.done;
    const snapshots = harness.engine.fs.write.mock.calls
      .filter(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(JSON.parse(snapshots.at(-1)![1]).observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ hook: "session.start", operation: "summary-answer", kind: "delivery", status: "accepted" }),
    ]));
  });

  it("retains rejected delivery for a summary answer", async () => {
    const harness = await start();
    const originalFetch = harness.engine.http.fetch.getMockImplementation()!;
    harness.engine.http.fetch.mockImplementation(async (url, init) =>
      init?.method === "POST" && url.includes("/summarize-jobs/")
        ? { ok: false, status: 500, text: "{}" }
        : originalFetch(url, init));
    await harness.trigger();
    await harness.done;
    const snapshots = harness.engine.fs.write.mock.calls
      .filter(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(JSON.parse(snapshots.at(-1)![1]).observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ hook: "session.start", operation: "summary-answer", kind: "delivery",
        status: "rejected", reason: "http-500" }),
    ]));
  });

  it.each(["lost response", "server error", "stale bearer"])("retries a worker answer after a %s without repeating completion", async failure => {
    const harness = await start({}, [{ ...leaf, pool: true, session_id: "foreign" }], { LCM_SUMMARIZE_WORKER: "1" });
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    let attempts = 0;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && url.includes("/summarize-jobs/") && ++attempts === 1) {
        if (failure === "lost response") throw new Error("request timeout");
        return { ok: false, status: failure === "stale bearer" ? 401 : 500, text: "{}" };
      }
      return fetch(url, init);
    });
    await harness.trigger();
    await harness.done;
    expect(attempts).toBe(2);
    expect(harness.engine.model.complete).toHaveBeenCalledOnce();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0].body.text).toBe("summary");
    if (failure === "stale bearer") expect(harness.engine.process.run).toHaveBeenCalledTimes(2);
  });

  it.each([403, 500])("bounds answer retries after HTTP %s and keeps polling", async status => {
    const harness = await start({}, [{ ...leaf, pool: true, session_id: "foreign" }], { LCM_SUMMARIZE_WORKER: "1" });
    const fetch = harness.engine.http.fetch.getMockImplementation()!;
    let attempts = 0;
    harness.engine.http.fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && url.includes("/summarize-jobs/")) {
        attempts++;
        return { ok: false, status, text: "{}" };
      }
      return fetch(url, init);
    });
    await harness.trigger();
    await harness.done;
    expect(attempts).toBe(status === 403 ? 1 : 3);
    expect(harness.engine.model.complete).toHaveBeenCalledOnce();
  });

  it("accepts the current model completion result shape", async () => {
    const harness = await start();
    harness.engine.model.complete.mockResolvedValue({
      isAnswered: true, text: " current result ", usage: { input_tokens: 3, output_tokens: 2 },
    });
    await harness.trigger();
    await harness.done;
    expect(harness.posts[0].body.text).toBe("current result");
    expect(harness.posts[0].body.usage).toEqual({ input_tokens: 3, output_tokens: 2, estimated: false });
  });

  it("treats a non-string completion text as unanswered instead of throwing", async () => {
    const { trigger, done, engine, posts } = await start();
    engine.model.complete.mockResolvedValue({
      isAnswered: true, text: { blocks: ["oops"] }, usage: { input_tokens: 3, output_tokens: 2 },
    });
    await trigger();
    await done;
    expect(posts[0].body).toEqual({
      error: "model.complete: answer text was not a string",
      usageAttempts: [{ providerId: "session:haiku",
        usage: { input_tokens: 3, output_tokens: 2, estimated: false }, failed: true }],
    });
  });

  it("falls back to Haiku when the fork's text is not a string", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ text: ["not", "a", "string"], usage: { input_tokens: 40, output_tokens: 7 } });
    await trigger();
    await done;
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
    expect(posts[0].body).toEqual({
      text: "summary", providerId: "session:haiku",
      usage: { input_tokens: 3, output_tokens: 2, estimated: true },
      usageAttempts: [{ providerId: "session:fork",
        usage: { input_tokens: 40, output_tokens: 7, estimated: false }, failed: true }],
    });
  });

  it("names model.fork when the fork's text is not a string and the fallback also fails", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ text: ["not", "a", "string"], usage: { input_tokens: 40, output_tokens: 7 } });
    engine.model.complete.mockResolvedValue({ isAnswered: false, reason: "refused",
      usage: { input_tokens: 3, output_tokens: 1 } });
    await trigger();
    await done;
    expect(posts[0].body).toEqual({
      error: "model.fork: answer text was not a string; fallback: refused",
      usageAttempts: [
        { providerId: "session:fork", usage: { input_tokens: 40, output_tokens: 7, estimated: false }, failed: true },
        { providerId: "session:haiku", usage: { input_tokens: 3, output_tokens: 1, estimated: false }, failed: true },
      ],
    });
  });

  it("reports a failed fork's usage separately from the fallback answer", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ isAnswered: false, reason: "empty-reply",
      usage: { input_tokens: 40, output_tokens: 7 } });
    await trigger();
    await done;
    expect(posts[0].body).toEqual({
      text: "summary", providerId: "session:haiku",
      usage: { input_tokens: 3, output_tokens: 2, estimated: true },
      usageAttempts: [{ providerId: "session:fork",
        usage: { input_tokens: 40, output_tokens: 7, estimated: false }, failed: true }],
    });
  });

  it("applies the output cap to a failed fork and its fallback together", async () => {
    const { trigger, done, engine, posts } = await start({ sessionSummarizerMaxOutputTokens: 3 }, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ isAnswered: false, reason: "empty-reply",
      usage: { input_tokens: 40, output_tokens: 3 } });
    await trigger();
    await done;
    expect(posts[0].body).toEqual({ error: "spend cap", usageAttempts: [
      { providerId: "session:fork", usage: { input_tokens: 40, output_tokens: 3, estimated: false }, failed: true },
    ] });
    expect(engine.model.complete).not.toHaveBeenCalled();
  });

  it("limits the fallback completion to tokens remaining after a failed fork", async () => {
    const { trigger, done, engine } = await start({ sessionSummarizerMaxOutputTokens: 10 }, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ isAnswered: false, reason: "empty-reply",
      usage: { input_tokens: 40, output_tokens: 7 } });
    await trigger();
    await done;
    expect(engine.model.complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 3 }));
  });

  it("uses forks for condensed jobs and accounts exact usage", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ text: " fork summary ", usage: { input_tokens: 100, output_tokens: 12 } });
    trigger();
    await done;
    expect(engine.model.fork).toHaveBeenCalledWith({ prompt: "system\n\nprompt" });
    expect(engine.model.complete).not.toHaveBeenCalled();
    expect(posts[0].body).toEqual({ text: "fork summary", providerId: "session:fork", usage: { input_tokens: 100, output_tokens: 12, estimated: false } });
  });

  it("falls back to Haiku when the fork returns null", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, kind: "condensed" }]);
    trigger();
    await done;
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
    expect(posts[0].body.providerId).toBe("session:haiku");
  });

  it("reports model errors and empty responses to the daemon", async () => {
    const { trigger, done, engine, posts } = await start({}, [leaf, { ...leaf, id: "job-2" }]);
    engine.model.complete.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(" ");
    trigger();
    await done;
    expect(posts.map((post) => post.body)).toEqual([{ error: "unavailable" }, {
      error: "empty summary", usageAttempts: [
        { providerId: "session:haiku", usage: { input_tokens: 3, output_tokens: 0, estimated: true }, failed: true },
      ],
    }]);
  });

  it("retains fork and completion usage when neither attempt answers", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, kind: "condensed" }]);
    engine.model.fork.mockResolvedValue({ isAnswered: false, reason: "empty-reply",
      usage: { input_tokens: 40, output_tokens: 7 } });
    engine.model.complete.mockResolvedValue({ isAnswered: false, reason: "empty-reply",
      usage: { input_tokens: 3, output_tokens: 2 } });
    await trigger();
    await done;
    expect(posts[0].body).toEqual({ error: "empty-reply", usageAttempts: [
      { providerId: "session:fork", usage: { input_tokens: 40, output_tokens: 7, estimated: false }, failed: true },
      { providerId: "session:haiku", usage: { input_tokens: 3, output_tokens: 2, estimated: false }, failed: true },
    ] });
  });

  it("stops when a response exceeds the spend cap", async () => {
    const { trigger, done, engine, posts } = await start({ sessionSummarizerMaxOutputTokens: 1 }, [leaf, leaf]);
    trigger();
    await done;
    expect(posts[0].body).toEqual({ error: "spend cap", usageAttempts: [
      { providerId: "session:haiku", usage: { input_tokens: 3, output_tokens: 2, estimated: true }, failed: false },
    ] });
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
  });

  it("does not spend again once the cap has been reached", async () => {
    const { trigger, done, engine, posts } = await start({ sessionSummarizerMaxOutputTokens: 2 }, [leaf, leaf]);
    trigger();
    await done;
    expect(posts[1].body).toEqual({ error: "spend cap" });
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps polling, once a minute, after the daemon says it has no such route", async () => {
    const { trigger, done, engine, posts, retries, jobs } = await start({}, []);
    trigger();
    await done; // first poll answered 404
    await vi.waitFor(() => expect(retries).toHaveLength(1));
    expect(engine.clock.after).toHaveBeenCalledWith(60_000, expect.any(Function));
    expect(engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("no /summarize-jobs/next route"));
    jobs.push(leaf); // a daemon with the route is back
    retries[0]();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.text).toBe("summary");
    expect(engine.ui.log).toHaveBeenCalledTimes(1); // the 404 was logged once, not per poll
  });

  it("never serves a job belonging to another session", async () => {
    const { trigger, done, engine, posts } = await start({}, [{ ...leaf, session_id: "other" }]);
    trigger();
    await done;
    expect(engine.model.complete).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it("switches to two-second short polling after a connection error", async () => {
    const { trigger, done, engine } = await start({}, [new Error("request timeout"), leaf]);
    trigger();
    await done;
    expect(engine.http.fetch).toHaveBeenCalledWith(expect.stringContaining("&wait_ms=0"), expect.anything());
    expect(engine.clock.after).toHaveBeenCalledWith(5_000, expect.any(Function));
    expect(engine.clock.after).toHaveBeenCalledWith(2_000, expect.any(Function));
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps polling after a 200 whose body is not JSON", async () => {
    const { trigger, done, engine } = await start({}, ["malformed", leaf]);
    trigger();
    await done;
    expect(engine.model.complete).toHaveBeenCalledTimes(1);
  });

  it("refreshes a stale bearer token after an unauthorized response", async () => {
    const { trigger, done, engine, posts } = await start({}, ["unauthorized", leaf]);
    engine.process.run
      .mockResolvedValueOnce({ stdout: "stale-token\n__CONFIG__\n{}", exitCode: 0 })
      .mockResolvedValue({ stdout: "replacement-token\n__CONFIG__\n{}", exitCode: 0 });
    trigger();
    await done;
    const polls = engine.http.fetch.mock.calls.filter(([url]) => url.includes("/summarize-jobs/next"));
    expect(polls[0][1]).toEqual({ headers: { authorization: "Bearer stale-token" } });
    expect(polls[1][1]).toEqual({ headers: { authorization: "Bearer replacement-token" } });
    expect(engine.clock.after).toHaveBeenCalledWith(5_000, expect.any(Function));
    expect(posts[0].body.text).toBe("summary");
  });
});
