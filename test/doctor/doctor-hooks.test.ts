import { describe, it, expect, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

// Mock ensureDaemon to prevent spawning real processes when daemon appears down
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

const LCM_BLOCK = "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";

function baseReadFileSync(p: string, settings: string) {
  if (p.endsWith("config.json")) return JSON.stringify({ llm: { provider: "claude-process" } });
  if (p.endsWith("settings.json")) return settings;
  if (p.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
  if (p.endsWith("CLAUDE.md")) return LCM_BLOCK;
  return "{}";
}

/** Build a settings object with hooks installed using the given node/mjs paths */
function makeHookSettings(nodePath: string, lcmMjsPath: string): string {
  const hooks: Record<string, any[]> = {};
  for (const { event, subcommand } of REQUIRED_HOOKS) {
    hooks[event] = [{ hooks: [{ command: `"${nodePath}" "${lcmMjsPath}" ${subcommand}` }] }];
  }
  return JSON.stringify({ mcpServers: { lcm: {} }, hooks });
}

describe("doctor hook validation", () => {
  it("reports hook-node-path as fail when hooks are absent from settings.json", async () => {
    const settings = JSON.stringify({ mcpServers: { "lcm": {} } });
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hook-node-path");
    expect(hookResult?.status).toBe("fail");
    expect(hookResult?.message).toContain("lcm install");
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

describe("hook-node-path check", () => {
  it("returns ok when hooks match process.execPath and lcmMjsPath exists", async () => {
    const lcmMjsPath = "/real/lcm.mjs";
    const settings = makeHookSettings(process.execPath, lcmMjsPath);
    const results = await runDoctor({
      existsSync: (_p: string) => true,
      readFileSync: (_p: string) => baseReadFileSync(_p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hook-node-path");
    expect(hookResult?.status).toBe("pass");
    expect(hookResult?.message).toContain("hooks registered");
  });

  it("returns warn and repairs when node path is stale", async () => {
    const lcmMjsPath = "/real/lcm.mjs";
    const settings = makeHookSettings("/old/node", lcmMjsPath);
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      existsSync: (_p: string) => true,
      readFileSync: (_p: string) => baseReadFileSync(_p, settings),
      writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hook-node-path");
    expect(hookResult?.status).toBe("warn");
    expect(hookResult?.fixApplied).toBe(true);
    expect(hookResult?.message).toContain("/old/node");
  });

  it("returns warn and repairs when lcmMjsPath does not exist on disk", async () => {
    const lcmMjsPath = "/deleted/lcm.mjs";
    const settings = makeHookSettings(process.execPath, lcmMjsPath);
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      existsSync: (p: string) => p !== lcmMjsPath,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hook-node-path");
    expect(hookResult?.status).toBe("warn");
    expect(hookResult?.fixApplied).toBe(true);
    expect(hookResult?.message).toContain("/deleted/lcm.mjs");
  });

  it("returns fail when no lcm hooks in settings.json", async () => {
    const settings = JSON.stringify({ mcpServers: { lcm: {} } });
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hook-node-path");
    expect(hookResult?.status).toBe("fail");
    expect(hookResult?.message).toContain("lcm install");
  });
});
