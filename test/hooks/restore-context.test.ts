// test/hooks/restore-context.test.ts — the module's replacement for the SessionStart hook.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionId = "session-1";
const coreBlocks = [{ name: "claudeMd", text: "# project" }];

async function start(restoreBody: unknown, options: { status?: number } = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const posts: { url: string; body: Record<string, any> }[] = [];
  const engine = {
    session: { id: vi.fn(async () => sessionId), cwd: vi.fn(async () => "/proj") },
    process: { run: vi.fn(async () => ({ stdout: "secret\n__CONFIG__\n{}\n__TMPDIR__/tmp", exitCode: 0 })) },
    fs: { writeFile: vi.fn(async () => undefined) },
    clock: { after: vi.fn() },
    ui: { log: vi.fn() },
    http: {
      fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posts.push({ url, body: JSON.parse(init.body!) });
          if (url.endsWith("/restore")) {
            return { ok: options.status === undefined, status: options.status ?? 200, text: JSON.stringify(restoreBody) };
          }
        }
        return { ok: true, status: 200, text: "{}" };
      }),
    },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, {});
  const fire = () => handlers.get("prompt.context")!(
    engine, { blocks: coreBlocks }, vi.fn(async (event: unknown) => event),
  );
  return { engine, posts, fire };
}

describe("function-hook restore context", () => {
  beforeEach(() => vi.resetModules());

  it("appends the daemon's context as one named block, after the core blocks", async () => {
    const { fire, posts } = await start({ context: "<context>remembered</context>" });
    const result = await fire();
    expect(posts[0].url).toContain("/restore");
    expect(posts[0].body).toEqual({ session_id: sessionId, cwd: "/proj" });
    expect(result.blocks).toEqual([
      ...coreBlocks,
      { name: "lcm", text: "<context>remembered</context>" },
    ]);
  });

  it("renders passive-capture insights the way the command hook did", async () => {
    const { fire } = await start({
      context: "<context>c</context>",
      insights: [{ content: "prefers pnpm", confidence: 0.8, tags: [] }],
    });
    const result = await fire();
    const block = result.blocks.at(-1);
    expect(block.text).toContain('<learned-insights source="passive-capture">');
    expect(block.text).toContain("- prefers pnpm (confidence: 0.8)");
  });

  it("adds no block when the daemon has nothing to restore", async () => {
    const { fire } = await start({ context: "" });
    expect((await fire()).blocks).toEqual(coreBlocks);
  });

  it("leaves the core blocks alone when the daemon is unreachable", async () => {
    const { fire } = await start(null, { status: 500 });
    expect((await fire()).blocks).toEqual(coreBlocks);
  });
});
