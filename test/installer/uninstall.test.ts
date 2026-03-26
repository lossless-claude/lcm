import { describe, it, expect, vi, afterEach } from "vitest";
import { removeClaudeSettings, teardownDaemonService, uninstall, type TeardownDeps } from "../../installer/uninstall.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0) {
  return vi.fn().mockReturnValue({ status, stdout: "", stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(existsResult = true, overrides: Partial<TeardownDeps> = {}) {
  return {
    spawnSync: makeSpawn(),
    existsSync: vi.fn().mockReturnValue(existsResult),
    rmSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    ...overrides,
  } as unknown as TeardownDeps & {
    spawnSync: ReturnType<typeof makeSpawn>;
    existsSync: ReturnType<typeof vi.fn>;
    rmSync: ReturnType<typeof vi.fn>;
    readFileSync: ReturnType<typeof vi.fn>;
    writeFileSync: ReturnType<typeof vi.fn>;
  };
}

// ─── removeClaudeSettings ───────────────────────────────────────────────────

describe("removeClaudeSettings", () => {
  it("removes lcm hooks and mcpServer", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "other" }] },
          { matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "lcm restore" }] },
        ],
      },
      mcpServers: { "lcm": {}, "other": {} },
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
    expect(r.hooks.SessionStart).toBeUndefined();
    expect(r.mcpServers["lcm"]).toBeUndefined();
    expect(r.mcpServers["other"]).toBeDefined();
  });

  it("removes all 4 lcm hook events", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "lcm restore" }] },
        ],
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "lcm session-end" }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: "lcm user-prompt" }] },
        ],
      },
      mcpServers: { "lcm": {} },
    });
    expect(r.hooks).toBeUndefined();
    expect(r.mcpServers).toBeUndefined();
  });

  it("removes entry when any sub-hook matches a lcm command", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "something-else" },
              { type: "command", command: "lcm compact --hook" },
            ],
          },
        ],
      },
      mcpServers: {},
    });
    expect(r.hooks).toBeUndefined();
  });

  it("removes absolute-path-format lcm hooks", () => {
    const existing = {
      hooks: {
        PreCompact: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/path/to/node" "/path/to/lcm.mjs" compact --hook' }],
        }],
      },
    };
    const r = removeClaudeSettings(existing);
    expect(r.hooks).toBeUndefined();
  });
});

// ─── teardownDaemonService ──────────────────────────────────────────────────

describe("teardownDaemonService", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("on macOS calls launchctl unload and removes plist when plist exists", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps(true);
    teardownDaemonService(deps);

    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("launchctl unload"))).toBe(true);
    expect(deps.rmSync).toHaveBeenCalledWith(
      expect.stringContaining("com.lossless-claude.daemon.plist")
    );
  });

  it("on macOS warns when plist does not exist", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("plist not found"));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(deps.rmSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("on Linux calls systemctl stop, disable, daemon-reload and removes unit file", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps(true);
    teardownDaemonService(deps);

    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("systemctl --user stop lossless-claude"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user disable lossless-claude"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user daemon-reload"))).toBe(true);
    expect(deps.rmSync).toHaveBeenCalledWith(
      expect.stringContaining("lossless-claude.service")
    );
  });

  it("on Linux warns when unit file does not exist but still runs systemctl commands", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unit file not found"));
    expect(deps.rmSync).not.toHaveBeenCalled();
    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("systemctl --user stop lossless-claude"))).toBe(true);
    warnSpy.mockRestore();
  });

  it("on unsupported platform warns and skips", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const deps = makeDeps();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform"));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(deps.rmSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── uninstall ──────────────────────────────────────────────────────────────

describe("uninstall", () => {
  it("removes settings via deps.writeFileSync when settings.json exists", async () => {
    const writeFileMock = vi.fn();
    const deps: TeardownDeps = {
      spawnSync: makeSpawn(),
      existsSync: vi.fn().mockReturnValue(true),
      rmSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }] },
        mcpServers: { "lcm": {} },
      })),
      writeFileSync: writeFileMock,
    };
    await uninstall(deps);
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.any(String)
    );
  });

  it("warns but does not throw when settings.json contains invalid JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps: TeardownDeps = {
      spawnSync: makeSpawn(),
      existsSync: vi.fn().mockReturnValue(true),
      rmSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue("not valid json"),
      writeFileSync: vi.fn(),
    };
    await expect(uninstall(deps)).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not update"));
    warnSpy.mockRestore();
  });
});

// ─── uninstall dry-run ───────────────────────────────────────────────────────

describe("uninstall with DryRunServiceDeps", () => {
  it("prints [dry-run] lines and writes no real files", async () => {
    const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(uninstall(new DryRunServiceDeps())).resolves.not.toThrow();

    const dryRunLines = logSpy.mock.calls
      .flatMap((c: any[]) => c)
      .filter((s: any) => typeof s === "string" && s.includes("[dry-run]"));

    expect(dryRunLines.length).toBeGreaterThan(0);
    // uninstall uses unload, not load — no launchctl load should appear
    expect(dryRunLines.every((l: string) => !l.includes("would run: launchctl load"))).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
