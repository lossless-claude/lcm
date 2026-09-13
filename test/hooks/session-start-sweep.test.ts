// test/hooks/session-start-sweep.test.ts — the function-hooks module's own catch-up trigger.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionId = "session-1";

describe("function-hook session.start", () => {
  beforeEach(() => vi.resetModules());

  it("fires the catch-up sweep with the documented route and payload", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const engine = {
      session: { id: vi.fn(async () => sessionId), cwd: vi.fn(async () => "/proj") },
      process: { run: vi.fn(async () => ({ stdout: "", exitCode: 0 })) },
      fs: { writeFile: vi.fn(async () => undefined) },
      clock: { after: vi.fn() },
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

    await handlers.get("session.start")!(engine, {}, vi.fn(async (event: unknown) => event));
    // The call is fire-and-forget: let its promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sweep = posts.find((post) => post.url.endsWith("/session-start-compact"));
    expect(sweep).toBeDefined();
    expect(sweep!.body).toEqual({ cwd: "/proj", session_id: sessionId });
  });
});
