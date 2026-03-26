import { describe, it, expect, vi } from "vitest";
import type { EnsureCoreDeps } from "../src/bootstrap.js";

function makeDeps(overrides: Partial<EnsureCoreDeps> = {}): EnsureCoreDeps {
  return {
    configPath: "/tmp/test-config.json",
    settingsPath: "/tmp/test-settings.json",
    nodePath: "/test/node",
    lcmMjsPath: "/test/lcm.mjs",
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
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

  it("skips config.json creation when it already exists", async () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: 1 })),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.configPath);
    expect(configWrites.length).toBe(0);
  });

  it("upserts hooks into settings.json when they are absent", async () => {
    const renameSync = vi.fn();
    const writeFileSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
      readFileSync: vi.fn().mockReturnValue("{}"),
      writeFileSync,
      renameSync,
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(renameSync).toHaveBeenCalledTimes(1);
    const tmpPath = renameSync.mock.calls[0][0];
    const tmpContent = writeFileSync.mock.calls.find((c: any[]) => c[0] === tmpPath)?.[1];
    const written = JSON.parse(tmpContent);
    expect(written.hooks?.PreCompact?.[0]?.hooks?.[0]?.command).toBe(
      '"/test/node" "/test/lcm.mjs" compact --hook',
    );
  });

  it("upserts hooks with the nodePath and lcmMjsPath from deps", async () => {
    const writeFileSync = vi.fn();
    const renameSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
      readFileSync: vi.fn().mockReturnValue("{}"),
      writeFileSync,
      renameSync,
      nodePath: "/custom/node",
      lcmMjsPath: "/custom/lcm.mjs",
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const tmpPath = renameSync.mock.calls[0]?.[0];
    const tmpWrite = writeFileSync.mock.calls.find((c: any[]) => c[0] === tmpPath);
    expect(tmpWrite).toBeDefined();
    const written = JSON.parse(tmpWrite![1]);
    const precompact = written.hooks?.PreCompact?.[0]?.hooks?.[0]?.command;
    expect(precompact).toBe('"/custom/node" "/custom/lcm.mjs" compact --hook');
  });

  it("skips write when hooks already match (hot path)", async () => {
    const renameSync = vi.fn();
    const { mergeClaudeSettings } = await import("../src/installer/settings.js");
    const goodSettings = mergeClaudeSettings(
      {},
      { intent: "upsert", nodePath: "/test/node", lcmMjsPath: "/test/lcm.mjs" },
    );
    const deps = makeDeps({
      existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify(goodSettings)),
      renameSync,
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(renameSync).not.toHaveBeenCalled();
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
