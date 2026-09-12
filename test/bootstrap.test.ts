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

  it("leaves an existing config.json alone", async () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: 1, other: "kept" })),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter((args) => args[0] === deps.configPath);
    expect(configWrites.length).toBe(0);
  });

  it("asks the daemon for its own package version, never a build id", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    const { PKG_VERSION } = await import("../src/daemon/version.js");
    await ensureCore(deps);
    const opts = (deps.ensureDaemon as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.expectedVersion).toBe(PKG_VERSION);
    expect(opts).not.toHaveProperty("expectedBuild");
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
  function bootstrapDeps(overrides: Partial<EnsureCoreDeps> = {}, flag: { exists: boolean; content?: string } = { exists: false }) {
    return {
      ...makeDeps(overrides),
      flagExists: vi.fn().mockReturnValue(flag.exists),
      readFlag: vi.fn().mockReturnValue(flag.content ?? ""),
      writeFlag: vi.fn(),
      warn: vi.fn(),
    };
  }

  it("skips ensureCore when flag file exists and reads the verdict back", async () => {
    const deps = bootstrapDeps({}, { exists: true, content: "" });
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    expect(await ensureBootstrapped("test-session", deps)).toEqual({ usable: true });
    expect(deps.ensureDaemon).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();

    const unusable = bootstrapDeps({}, { exists: true, content: "unusable: lcm: daemon v9.0.0 ..." });
    expect(await ensureBootstrapped("test-session", unusable)).toEqual({ usable: false });
    expect(unusable.warn).not.toHaveBeenCalled(); // the line was written by the first hook
  });

  it("runs ensureCore, writes an empty flag and stays quiet when the daemon is current", async () => {
    const deps = bootstrapDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    expect(await ensureBootstrapped("test-session", deps)).toEqual({ usable: true });
    expect(deps.ensureDaemon).toHaveBeenCalled();
    expect(deps.writeFlag).toHaveBeenCalledWith(expect.stringContaining("bootstrapped-test-session.flag"), "");
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("writes one stderr line naming the repair when the daemon did not start, and keeps the session usable", async () => {
    const deps = bootstrapDeps({ ensureDaemon: vi.fn().mockResolvedValue({ connected: false }) });
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    expect(await ensureBootstrapped("s", deps)).toEqual({ usable: true });
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn.mock.calls[0][0]).toMatch(/^lcm: daemon did not start .*Repair: lcm daemon start$/);
    expect(deps.writeFlag).toHaveBeenCalledWith(expect.any(String), "");
  });

  it("marks the session unusable and names the update command when the daemon is newer and incompatible", async () => {
    const deps = bootstrapDeps({
      ensureDaemon: vi.fn().mockResolvedValue({ connected: false, ownership: "incompatible", daemonVersion: "9.0.0" }),
    });
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    expect(await ensureBootstrapped("s", deps)).toEqual({ usable: false });
    expect(deps.warn).toHaveBeenCalledTimes(1);
    const line: string = deps.warn.mock.calls[0][0];
    expect(line).toMatch(/^lcm: daemon v9\.0\.0 is newer than this hook .*incompatible.*Repair: npm install -g @lossless-claude\/lcm@latest$/);
    expect(deps.writeFlag).toHaveBeenCalledWith(expect.any(String), `unusable: ${line}`);
  });

  it("connects to a newer compatible daemon and says so once", async () => {
    const deps = bootstrapDeps({
      ensureDaemon: vi.fn().mockResolvedValue({ connected: true, ownership: "older-caller", daemonVersion: "0.99.1" }),
    });
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    expect(await ensureBootstrapped("s", deps)).toEqual({ usable: true });
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn.mock.calls[0][0]).toMatch(/is newer than this hook .*connected\. Update with: /);
  });
});
