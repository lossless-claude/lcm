import { describe, it, expect, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

// Mock ensureDaemon to prevent spawning real processes when daemon appears down
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

const LCM_BLOCK = "<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->\n";

function baseReadFileSync(p: string, settings: string) {
  if (p.endsWith("config.json")) return JSON.stringify({ llm: { provider: "claude-process" } });
  if (p.endsWith("settings.json")) return settings;
  if (p.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
  if (p.endsWith("CLAUDE.md")) return LCM_BLOCK;
  return "{}";
}

describe("doctor hook validation", () => {
  it("reports hooks as passing when they are absent from settings.json", async () => {
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
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("pass");
    for (const { event } of REQUIRED_HOOKS) {
      expect(hookResult?.message).toContain(event);
    }
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
