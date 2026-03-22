import { describe, it, expect, vi } from "vitest";
import { validateAndFixHooks, type AutoHealDeps } from "../../src/hooks/auto-heal.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

function makeDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    settingsPath: "/tmp/test-settings.json",
    logPath: "/tmp/test-auto-heal.log",
    ...overrides,
  };
}

describe("validateAndFixHooks", () => {
  it("removes duplicate lcm hooks from settings.json", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact" }] }],
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lcm restore" }] }],
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(written.hooks.PreCompact).toBeUndefined();
    expect(written.hooks.SessionStart).toBeUndefined();
    expect(written.hooks.PostToolUse).toEqual([{ matcher: "", hooks: [{ type: "command", command: "other" }] }]);
  });

  it("no-ops when no managed hooks are present", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("removes leaked mcpServers.lcm even when no managed hooks are present", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
        mcpServers: {
          lcm: { command: "lcm", args: ["mcp"] },
          other: { command: "other", args: ["mcp"] },
        },
      })),
    });

    validateAndFixHooks(deps);

    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(written.hooks.PostToolUse).toEqual([{ matcher: "", hooks: [{ type: "command", command: "other" }] }]);
    expect(written.mcpServers.lcm).toBeUndefined();
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
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(deps.appendFileSync).not.toHaveBeenCalled();
  });
});
