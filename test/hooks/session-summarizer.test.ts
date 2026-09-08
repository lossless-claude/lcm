import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionId = "session/one";
const leaf = { id: "job-1", session_id: sessionId, kind: "leaf", system: "system", prompt: "prompt", maxTokens: 1024 };

async function start(options: Record<string, number> = {}, jobs: unknown[] = [leaf]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const posts: { url: string; body: Record<string, any> }[] = [];
  // The poller's one-minute wait after a 404 is parked here instead of firing: the harness
  // answers 404 when its jobs run out, and a test decides whether the poller wakes again.
  const retries: (() => void)[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const engine = {
    session: { id: vi.fn(async () => sessionId) },
    process: { run: vi.fn(async () => ({ stdout: "secret\n__CONFIG__\n{}", exitCode: 0 })) },
    model: {
      complete: vi.fn(async () => "  summary  "),
      fork: vi.fn(async (): Promise<any> => null),
    },
    clock: { after: vi.fn((ms: number, callback: () => void) => { if (ms >= 60_000) retries.push(callback); else callback(); }) },
    ui: { log: vi.fn() },
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body!);
          posts.push({ url, body });
          if (body.error === "spend cap") finish();
          return { ok: true, status: 200, text: "{}" };
        }
        if (url.endsWith("/health")) return { ok: true, status: 200, text: "{}" };
        if (jobs.length) {
          const job = jobs.shift();
          if (job instanceof Error) throw job;
          if (job === "unauthorized") return { ok: false, status: 401, text: "" };
          return { ok: true, status: 200, text: JSON.stringify({ job }) };
        }
        finish();
        return { ok: false, status: 404, text: "" };
      }),
    },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, options);
  const trigger = () => handlers.get("session.start")!(engine, {}, vi.fn((event) => event));
  return { engine, posts, done, trigger, retries, jobs };
}

describe("function-hook session summarizer", () => {
  beforeEach(() => vi.resetModules());

  it("does not poll when disabled and leaves session.start nonblocking", async () => {
    const harness = await start({ sessionSummarizerMaxOutputTokens: 0 });
    expect(harness.trigger()).toEqual({});
    await Promise.resolve();
    expect(harness.engine.session.id).not.toHaveBeenCalled();
  });

  it("starts one poller, uses the session bearer, and reports estimated Haiku usage", async () => {
    const { trigger, done, engine, posts } = await start();
    trigger();
    trigger();
    await done;
    expect(engine.session.id).toHaveBeenCalledTimes(1);
    expect(engine.http.fetch).toHaveBeenCalledWith(
      expect.stringContaining("session_id=session%2Fone"),
      { headers: { authorization: "Bearer secret" } },
    );
    expect(engine.model.complete).toHaveBeenCalledWith({ model: "haiku", system: "system", prompt: "prompt", maxTokens: 1024 });
    expect(posts[0].body).toEqual({ text: "summary", providerId: "session:haiku", usage: { input_tokens: 3, output_tokens: 2, estimated: true } });
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
    expect(posts.map((post) => post.body)).toEqual([{ error: "unavailable" }, { error: "empty summary" }]);
  });

  it("stops when a response exceeds the spend cap", async () => {
    const { trigger, done, engine, posts } = await start({ sessionSummarizerMaxOutputTokens: 1 }, [leaf, leaf]);
    trigger();
    await done;
    expect(posts[0].body).toEqual({ error: "spend cap" });
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
