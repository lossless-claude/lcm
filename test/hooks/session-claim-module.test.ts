// test/hooks/session-claim-module.test.ts — the module's side of the session claim, read
// back through the command hooks' own reader.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { claimPath, functionHooksOwnSession } from "../../src/hooks/session-claim.js";

/** Claim files sit at fixed paths in the shared temp dir, so ids are unique per process. */
const sid = (name: string): string => `${name}-p${process.pid}`;
const used: string[] = [];

async function load() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const engine = {
    // The host's own environment, so the module looks where os.tmpdir() does on this platform.
    env: { get: vi.fn(async (name: string): Promise<string | undefined> => process.env[name]) },
    session: { id: vi.fn(async () => ""), cwd: vi.fn(async () => "/proj") },
    process: { run: vi.fn(async () => ({ stdout: "secret\n__CONFIG__\n{}", exitCode: 0 })) },
    fs: { write: vi.fn(async (path: string, text: string) => writeFileSync(path, text)) },
    clock: { after: vi.fn(), sleep: vi.fn(async () => undefined) },
    ui: { log: vi.fn() },
    http: { fetch: vi.fn(async () => ({ ok: true, status: 200, text: "{}" })) },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, {});
  const fire = (event: string, e: Record<string, unknown>, next = vi.fn(async (input: unknown) => input)) => {
    const hook = handlers.get(event);
    if (!hook) throw new Error(`the module registers no ${event} hook`);
    return hook(engine, e, next);
  };
  return { engine, fire };
}

function classic(event: string, sessionId: string, extra: Record<string, unknown> = {}) {
  used.push(sessionId);
  return Object.freeze({
    hook_event_name: event, session_id: sessionId, cwd: "/proj",
    transcript_path: `/home/.claude/projects/-proj/${sessionId}.jsonl`, ...extra,
  });
}

describe("function-hooks module: session claim", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { for (const id of used.splice(0)) rmSync(claimPath(id), { force: true }); });

  it.each(["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"])(
    "claims the session in classic.%s before the command hooks beneath it run", async (event) => {
      const { fire } = await load();
      const id = sid(`claim-${event}`);
      const e = classic(event, id);
      let ownedWhenCommandHooksRan: boolean | undefined;
      const next = vi.fn(async (input: unknown) => {
        ownedWhenCommandHooksRan = functionHooksOwnSession(id);
        return { passed: input };
      });
      await expect(fire(`classic.${event}`, e, next)).resolves.toEqual({ passed: e });
      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0][0]).toBe(e);
      expect(ownedWhenCommandHooksRan).toBe(true);
    });

  // /clear, /resume and /branch end one session id and continue under another, with no
  // session.start for the new one.
  it("follows a session id change that no session.start announces", async () => {
    const { fire } = await load();
    const before = sid("before-clear");
    const after = sid("after-clear");
    await fire("classic.SessionStart", classic("SessionStart", before, { source: "startup" }));
    expect(functionHooksOwnSession(before)).toBe(true);

    const end = Object.freeze({ reason: "clear", sessionId: before, resume: {} });
    const endNext = vi.fn(async () => ({ sessionId: before }));
    await expect(fire("session.end", end, endNext)).resolves.toEqual({ sessionId: before });
    expect(endNext).toHaveBeenCalledWith(end);
    expect(functionHooksOwnSession(before)).toBe(false);
    expect(JSON.parse(readFileSync(claimPath(before), "utf-8"))).toMatchObject({ sessionId: before, ended: "clear" });

    let ownedAtRestore: boolean | undefined;
    await fire("classic.SessionStart", classic("SessionStart", after, { source: "clear" }), vi.fn(async (input: unknown) => {
      ownedAtRestore = functionHooksOwnSession(after);
      return input;
    }));
    expect(ownedAtRestore).toBe(true);
    expect(functionHooksOwnSession(before)).toBe(false);
  });

  it("passes the event on when the claim cannot be written", async () => {
    const { engine, fire } = await load();
    engine.fs.write.mockRejectedValue(new Error("EACCES"));
    const id = sid("unwritable");
    const e = classic("UserPromptSubmit", id);
    const next = vi.fn(async () => ({}));
    await expect(fire("classic.UserPromptSubmit", e, next)).resolves.toEqual({});
    expect(next).toHaveBeenCalledWith(e);
    expect(functionHooksOwnSession(id)).toBe(false);
    expect(engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("command hooks stay active"));
  });

  it("still ends the session when the claim cannot be withdrawn", async () => {
    const { engine, fire } = await load();
    engine.fs.write.mockRejectedValue(new Error("EACCES"));
    const end = { reason: "prompt_input_exit", sessionId: sid("exit"), resume: {} };
    const next = vi.fn(async () => ({ sessionId: end.sessionId }));
    await expect(fire("session.end", end, next)).resolves.toEqual({ sessionId: end.sessionId });
    expect(next).toHaveBeenCalledWith(end);
  });
});

// The command hooks name the claim from Node's os.tmpdir(). A shell's TMPDIR is not that
// on Windows: Git Bash answers /tmp, which the module's $.fs wrote as C:\tmp, so no
// command hook ever saw a claim and every event was captured twice.
describe("function-hooks module: claim temp dir", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { for (const id of used.splice(0)) rmSync(claimPath(id), { force: true }); });

  const claimWrite = (write: { mock: { calls: unknown[][] } }): string | undefined =>
    write.mock.calls.map(([path]) => String(path)).find((path) => path.includes("lcm-claim-"));

  it("writes the claim to the very file the command hooks read on this platform", async () => {
    const { engine, fire } = await load();
    const id = sid("platform-dir");
    await fire("classic.Stop", classic("Stop", id));
    expect(resolve(claimWrite(engine.fs.write) ?? "")).toBe(claimPath(id));
  });

  it.each([
    ["Windows: TEMP without its trailing backslash, never TMPDIR",
      { OS: "Windows_NT", TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp\\", TMP: "D:\\other", TMPDIR: "/tmp" },
      "C:\\Users\\dev\\AppData\\Local\\Temp/lcm-claim-"],
    ["Windows: TMP when TEMP is unset", { OS: "Windows_NT", TMP: "D:\\scratch" }, "D:\\scratch/lcm-claim-"],
    ["Windows: SystemRoot\\temp when neither is set", { OS: "Windows_NT", SystemRoot: "C:\\Windows" },
      "C:\\Windows\\temp/lcm-claim-"],
    ["Windows without OS: SystemRoot marks it, TEMP over TMPDIR",
      { SystemRoot: "C:\\Windows", TEMP: "C:\\T", TMPDIR: "/tmp" }, "C:\\T/lcm-claim-"],
    ["POSIX: TMPDIR without its trailing slash", { TMPDIR: "/var/folders/xy/T/", TMP: "/ignored", TEMP: "/ignored" },
      "/var/folders/xy/T/lcm-claim-"],
    ["POSIX: TMP, then TEMP", { TMP: "/scratch", TEMP: "/ignored" }, "/scratch/lcm-claim-"],
    ["POSIX: /tmp when nothing is set", {}, "/tmp/lcm-claim-"],
  ])("%s", async (_name, environment: Record<string, string>, prefix) => {
    const { engine, fire } = await load();
    engine.env.get.mockImplementation(async (name: string) => environment[name]);
    engine.fs.write.mockResolvedValue(undefined);
    await fire("classic.UserPromptSubmit", classic("UserPromptSubmit", sid("env-shape")));
    expect(claimWrite(engine.fs.write)?.slice(0, prefix.length)).toBe(prefix);
  });

  it("falls back to /tmp on a host without $.env, and says so", async () => {
    const { engine, fire } = await load();
    (engine as { env?: unknown }).env = undefined;
    engine.fs.write.mockResolvedValue(undefined);
    await fire("classic.UserPromptSubmit", classic("UserPromptSubmit", sid("no-env")));
    expect(claimWrite(engine.fs.write)).toMatch(/^\/tmp\/lcm-claim-/);
    expect(engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("could not read the temp dir"));
  });
});
