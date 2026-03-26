import { describe, it, expect, vi } from "vitest";
import { validateAndFixHooks, type AutoHealDeps } from "../../src/hooks/auto-heal.js";

function makeDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    settingsPath: "/tmp/test-settings.json",
    logPath: "/tmp/test-auto-heal.log",
    nodePath: "/test/node",
    lcmMjsPath: "/test/lcm.mjs",
    ...overrides,
  };
}

describe("validateAndFixHooks", () => {
  it("upserts absolute-path hooks when bare-format hooks are found", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.renameSync).toHaveBeenCalledTimes(1);
    const tmpPath = (deps.renameSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const tmpWrite = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === tmpPath,
    );
    const written = JSON.parse(tmpWrite![1]);
    const precompactCmd = written.hooks.PreCompact?.[0]?.hooks?.[0]?.command;
    expect(precompactCmd).toBe('"/test/node" "/test/lcm.mjs" compact --hook');
    // Unrelated hook preserved
    const postToolCmd = written.hooks.PostToolUse?.[0]?.hooks?.[0]?.command;
    expect(postToolCmd).toBe("other");
  });

  it("no-ops when all hooks already have correct absolute paths", () => {
    const correctSettings = {
      hooks: {
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" post-tool' }] }],
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" compact --hook' }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" restore' }] }],
        SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" session-end' }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" user-prompt' }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" session-snapshot' }] }],
      },
    };
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify(correctSettings)),
    });
    validateAndFixHooks(deps);
    expect(deps.renameSync).not.toHaveBeenCalled();
  });

  it("preserves mcpServers.lcm when upserting hooks", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
        mcpServers: {
          lcm: { command: "lcm", args: ["mcp"] },
          other: { command: "other", args: ["mcp"] },
        },
      })),
    });

    validateAndFixHooks(deps);

    expect(deps.renameSync).toHaveBeenCalledTimes(1);
    const tmpPath = (deps.renameSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const tmpWrite = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === tmpPath,
    );
    const written = JSON.parse(tmpWrite![1]);
    // PreCompact hook was upserted to absolute path
    const precompactCmd = written.hooks.PreCompact?.[0]?.hooks?.[0]?.command;
    expect(precompactCmd).toBe('"/test/node" "/test/lcm.mjs" compact --hook');
    expect(written.hooks.PostToolUse?.[0]?.hooks?.[0]?.command).toBe("other");
    // mcpServers.lcm is preserved
    expect(written.mcpServers.lcm).toEqual({ command: "lcm", args: ["mcp"] });
    expect(written.mcpServers.other).toEqual({ command: "other", args: ["mcp"] });
  });

  it("does not throw on fs errors", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
  });

  it("logs errors to auto-heal.log", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    validateAndFixHooks(deps);
    expect(deps.appendFileSync).toHaveBeenCalledWith(
      deps.logPath,
      expect.stringContaining("ENOENT"),
    );
  });

  it("handles corrupt settings.json gracefully", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue("not valid json {{{"),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
    expect(deps.appendFileSync).toHaveBeenCalledWith(
      deps.logPath,
      expect.stringContaining("auto-heal error"),
    );
  });

  it("handles missing settings.json gracefully", () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
    });
    validateAndFixHooks(deps);
    expect(deps.renameSync).not.toHaveBeenCalled();
    expect(deps.appendFileSync).not.toHaveBeenCalled();
  });

  it("upserts hooks into empty settings (no hooks key)", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({})),
    });
    validateAndFixHooks(deps);
    expect(deps.renameSync).toHaveBeenCalledTimes(1);
    const tmpPath = (deps.renameSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const tmpWrite = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === tmpPath,
    );
    const written = JSON.parse(tmpWrite![1]);
    // All 6 hooks must be present
    expect(written.hooks.PostToolUse).toBeDefined();
    expect(written.hooks.PreCompact).toBeDefined();
    expect(written.hooks.SessionStart).toBeDefined();
    expect(written.hooks.SessionEnd).toBeDefined();
    expect(written.hooks.UserPromptSubmit).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
  });

  it("uses atomic write: writes to tmp then renames to settingsPath", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({})),
    });
    validateAndFixHooks(deps);
    const renameCall = (deps.renameSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(renameCall[0]).toMatch(/^\/tmp\/test-settings\.json\.[a-f0-9]+\.tmp$/);
    expect(renameCall[1]).toBe("/tmp/test-settings.json");
  });
});
