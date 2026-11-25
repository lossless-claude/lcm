// test/hooks/session-start-sweep.test.ts — the function-hooks module's own catch-up trigger.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionId = "session-1";

async function load() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const engine = {
    session: { id: vi.fn(async () => sessionId), cwd: vi.fn(async () => "/proj") },
    process: { run: vi.fn(async () => ({ stdout: "", exitCode: 0 })) },
    fs: { writeFile: vi.fn(async () => undefined) },
    clock: { after: vi.fn(), sleep: vi.fn(() => new Promise<void>(() => {})) },
    ui: { log: vi.fn() },
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body!) });
        return { ok: true, status: 200, text: "{}" };
      }),
    },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, {});
  const fire = async (event: string, e: Record<string, unknown>) => {
    await handlers.get(event)!(engine, e, vi.fn(async (input: unknown) => input));
    // The call is fire-and-forget: let its promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const sweeps = () => posts.filter((post) => post.url.endsWith("/session-start-compact")).map((post) => post.body);
  return { fire, sweeps };
}

describe("function-hook session.start", () => {
  beforeEach(() => vi.resetModules());

  it("fires the catch-up sweep with the documented route and payload", async () => {
    const { fire, sweeps } = await load();
    await fire("session.start", {});
    expect(sweeps()).toEqual([{ cwd: "/proj", session_id: sessionId }]);
  });

  // No session.start fires for these, and the SessionStart command hook that swept on them
  // stands down while the module holds the claim.
  it.each(["clear", "resume", "fork", "compact"])(
    "fires the catch-up sweep for the new session id on a %s SessionStart", async (source) => {
      const { fire, sweeps } = await load();
      await fire("classic.SessionStart", { session_id: "after", cwd: "/other", source });
      expect(sweeps()).toEqual([{ cwd: "/other", session_id: "after" }]);
    });

  it("leaves the startup sweep to session.start", async () => {
    const { fire, sweeps } = await load();
    await fire("classic.SessionStart", { session_id: sessionId, cwd: "/proj", source: "startup" });
    expect(sweeps()).toEqual([]);
  });
});
