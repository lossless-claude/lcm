import { describe, it, expect, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

// Mock ensureDaemon to prevent spawning real processes when daemon appears down
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

const LCM_BLOCK = "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";

const INSTALLED_LCM = JSON.stringify({ version: 2, plugins: { "lcm@lossless-claude": [{ scope: "user", version: "0.9.0" }] } });
const NO_PLUGINS = JSON.stringify({ version: 2, plugins: { "magi@dev-marketplace": [{ scope: "user" }] } });

function baseReadFileSync(p: string, settings: string, registry: string = INSTALLED_LCM) {
  if (p.endsWith("config.json")) return JSON.stringify({ llm: { provider: "claude-process" } });
  if (p.endsWith("settings.json")) return settings;
  if (p.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
  if (p.endsWith("CLAUDE.md")) return LCM_BLOCK;
  if (p.endsWith("installed_plugins.json")) return registry;
  return "{}";
}

function depsFor(settings: string, registry: string = INSTALLED_LCM, writeFileSync = vi.fn()) {
  return {
    existsSync: () => true,
    readFileSync: (p: string) => baseReadFileSync(p, settings, registry),
    writeFileSync,
    mkdirSync: vi.fn(),
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    fetch: vi.fn().mockResolvedValue({ ok: false }),
    homedir: "/tmp/test-home",
    lcmHome: "/tmp/test-home/.lossless-claude",
    platform: "darwin",
  };
}

function settingsWithLcmHooks(extra: Record<string, unknown> = {}): string {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, command } of REQUIRED_HOOKS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks, mcpServers: { lcm: {} }, ...extra });
}

describe("doctor hook validation", () => {
  it("reports hooks as passing when the lcm plugin is installed and settings.json has no copies", async () => {
    const settings = JSON.stringify({ mcpServers: { "lcm": {} } });
    const results = await runDoctor(depsFor(settings));
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("pass");
    expect(hookResult?.message).toContain("lcm@lossless-claude");
    for (const { event } of REQUIRED_HOOKS) {
      expect(hookResult?.message).toContain(event);
    }
  });

  it("fails when the lcm plugin is not installed and settings.json has no hooks", async () => {
    const settings = JSON.stringify({ mcpServers: { "lcm": {} } });
    const results = await runDoctor(depsFor(settings, NO_PLUGINS));
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("fail");
    expect(hookResult?.message).toContain("claude plugin install lcm@lossless-claude");
    for (const { event } of REQUIRED_HOOKS) {
      expect(hookResult?.message).toContain(event);
    }
    // Passive-learning checks are meaningless without hooks
    expect(results.some(r => r.category === "Passive Learning")).toBe(false);
  });

  it("fails when the registry file is missing entirely", async () => {
    const settings = JSON.stringify({ mcpServers: { "lcm": {} } });
    const deps = depsFor(settings);
    deps.readFileSync = (p: string) => {
      if (p.endsWith("installed_plugins.json")) throw new Error("ENOENT");
      return baseReadFileSync(p, settings);
    };
    const results = await runDoctor(deps);
    expect(results.find(r => r.name === "hooks")?.status).toBe("fail");
  });

  it("fails when the lcm plugin is installed but disabled in enabledPlugins", async () => {
    const settings = JSON.stringify({ mcpServers: { "lcm": {} }, enabledPlugins: { "lcm@lossless-claude": false } });
    const results = await runDoctor(depsFor(settings));
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("fail");
    expect(hookResult?.message).toContain("disabled");
  });

  it("passes via legacy settings.json hooks when the plugin is absent, and does not strip them", async () => {
    const writeFileSync = vi.fn();
    const results = await runDoctor(depsFor(settingsWithLcmHooks(), NO_PLUGINS, writeFileSync));
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("pass");
    expect(hookResult?.message).toContain("via settings.json");
    const settingsWrites = writeFileSync.mock.calls.filter(c => String(c[0]).endsWith("settings.json"));
    for (const call of settingsWrites) {
      const written = JSON.parse(String(call[1]));
      expect(Object.keys(written.hooks ?? {}).length).toBe(REQUIRED_HOOKS.length);
    }
  });

  it("does not strip legacy hooks while re-adding mcpServers.lcm when the plugin is absent", async () => {
    const writeFileSync = vi.fn();
    const hooks: Record<string, unknown[]> = {};
    for (const { event, command } of REQUIRED_HOOKS) hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
    const results = await runDoctor(depsFor(JSON.stringify({ hooks }), NO_PLUGINS, writeFileSync));
    expect(results.find(r => r.name === "mcp-lcm")?.fixApplied).toBe(true);
    const settingsWrites = writeFileSync.mock.calls.filter(c => String(c[0]).endsWith("settings.json"));
    const lastWrite = JSON.parse(String(settingsWrites.at(-1)?.[1]));
    expect(lastWrite.mcpServers.lcm).toBeDefined();
    expect(Object.keys(lastWrite.hooks).length).toBe(REQUIRED_HOOKS.length);
  });

  it("does not strip legacy hooks while re-adding mcpServers.lcm when the plugin is installed but disabled", async () => {
    const writeFileSync = vi.fn();
    const hooks: Record<string, unknown[]> = {};
    for (const { event, command } of REQUIRED_HOOKS) hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
    const settings = JSON.stringify({ hooks, enabledPlugins: { "lcm@lossless-claude": false } });
    const results = await runDoctor(depsFor(settings, INSTALLED_LCM, writeFileSync));
    expect(results.find(r => r.name === "mcp-lcm")?.fixApplied).toBe(true);
    const settingsWrites = writeFileSync.mock.calls.filter(c => String(c[0]).endsWith("settings.json"));
    const lastWrite = JSON.parse(String(settingsWrites.at(-1)?.[1]));
    expect(lastWrite.mcpServers.lcm).toBeDefined();
    expect(Object.keys(lastWrite.hooks).length).toBe(REQUIRED_HOOKS.length);
  });

  it("strips duplicate settings.json hooks when the plugin is installed", async () => {
    const writeFileSync = vi.fn();
    const results = await runDoctor(depsFor(settingsWithLcmHooks(), INSTALLED_LCM, writeFileSync));
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("warn");
    expect(hookResult?.fixApplied).toBe(true);
    const written = JSON.parse(String(writeFileSync.mock.calls[0][1]));
    expect(written.hooks).toBeUndefined();
  });

  it("reports pass when mcpServers.lcm is present in settings.json", async () => {
    const settings = JSON.stringify({ mcpServers: { lcm: { command: "lcm", args: ["mcp"] } } });
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
    lcmHome: "/tmp/test-home/.lossless-claude",
      platform: "darwin",
    });
    const mcpResult = results.find(r => r.name === "mcp-lcm");
    expect(mcpResult?.status).toBe("pass");
    expect(mcpResult?.message).toContain("registered");
  });

  it("re-adds mcpServers.lcm when missing from settings.json", async () => {
    const settings = JSON.stringify({ mcpServers: {} });
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
    lcmHome: "/tmp/test-home/.lossless-claude",
      platform: "darwin",
    });
    const mcpResult = results.find(r => r.name === "mcp-lcm");
    expect(mcpResult?.status).toBe("warn");
    expect(mcpResult?.message).toContain("missing");
    // doctor should have written the entry back to settings.json
    const settingsWritten = writtenFiles.get("/tmp/test-home/.claude/settings.json");
    expect(settingsWritten).toBeDefined();
    const written = JSON.parse(settingsWritten!);
    expect(written.mcpServers?.lcm).toBeDefined();
  });
});
