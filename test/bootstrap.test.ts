import { describe, it, expect, vi } from "vitest";
import type { EnsureCoreDeps } from "../src/bootstrap.js";

function makeDeps(overrides: Partial<EnsureCoreDeps> = {}): EnsureCoreDeps {
  return {
    configPath: "/tmp/test-config.json",
    settingsPath: "/tmp/test-settings.json",
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    ...overrides,
  };
}

describe("ensureCore", () => {
  it("creates config.json with defaults when missing", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      deps.configPath,
      expect.stringContaining('"version"'),
    );
  });

  it("skips full config.json recreation when it already exists", async () => {
    // readFileSync already reports the running process's node path, so recordMcpNodePath
    // has nothing to patch either — the only way to get zero writes to configPath.
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: 1, mcpNodePath: process.execPath })),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.configPath);
    expect(configWrites.length).toBe(0);
  });

  it("records the running node interpreter's absolute path into config.json", async () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: 1, other: "kept" })),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.configPath);
    expect(configWrites.length).toBe(1);
    const written = JSON.parse(configWrites[0][1]);
    expect(written.mcpNodePath).toBe(process.execPath);
    expect(written.other).toBe("kept"); // read-modify-write preserves unrelated keys
  });

  it("does not touch config.json when it cannot be read (corrupt or unreadable)", async () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("EACCES"); }),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.configPath);
    expect(configWrites.length).toBe(0);
  });

  it("calls mergeClaudeSettings to clean stale hooks", async () => {
    const settingsWithDupes = JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
      },
    });
    const deps = makeDeps({
      existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
      readFileSync: vi.fn().mockReturnValue(settingsWithDupes),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const settingsWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.settingsPath);
    expect(settingsWrites.length).toBe(1);
    const written = JSON.parse(settingsWrites[0][1]);
    expect(written.hooks?.PreCompact).toBeUndefined();
  });

  it("starts daemon if not running", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.ensureDaemon).toHaveBeenCalled();
  });

  it("calls chmodSync(0o600) on config.json after creation", async () => {
    const chmodSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      chmodSync,
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(chmodSync).toHaveBeenCalledWith(deps.configPath, 0o600);
  });
});

describe("ensureBootstrapped", () => {
  it("skips ensureCore when flag file exists", async () => {
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(true),
      writeFlag: vi.fn(),
    });
    expect(coreDeps.ensureDaemon).not.toHaveBeenCalled();
  });

  it("runs ensureCore and writes flag when flag file missing", async () => {
    const writeFlag = vi.fn();
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(false),
      writeFlag,
    });
    expect(coreDeps.ensureDaemon).toHaveBeenCalled();
    expect(writeFlag).toHaveBeenCalled();
  });
});
