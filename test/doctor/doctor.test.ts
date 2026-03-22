import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

function buildSettingsJson(): string {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, command } of REQUIRED_HOOKS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks, mcpServers: { "lcm": {} } });
}

function minimalDeps(overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
  return {
    existsSync: () => true,
    readFileSync: (path: string) => {
      if (path.endsWith("config.json")) return "{}";
      if (path.endsWith("settings.json")) return buildSettingsJson();
      if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
      return "{}";
    },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    fetch: vi.fn().mockResolvedValue({ ok: false }),
    homedir: "/tmp/test-home",
    platform: "darwin",
    ...overrides,
  };
}

describe("runDoctor security section", () => {
  it("shows built-in pattern count as pass", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const builtIn = results.find((r) => r.name === "built-in-patterns");
    expect(builtIn?.status).toBe("pass");
    expect(builtIn?.message).toContain("active");
    expect(builtIn?.category).toBe("Security");
  });

  it("warns when no project patterns are configured", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const proj = results.find((r) => r.name === "project-patterns");
    expect(proj?.status).toBe("warn");
    expect(proj?.message).toContain("none configured");
  });
});

describe("runDoctor summarizer modes", () => {
  it("reports auto mode as Claude and Codex process defaults", async () => {
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return JSON.stringify({ llm: { provider: "auto" } });
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        return "{}";
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1]?.includes("command -v claude")) {
          return { status: 0, stdout: "/usr/bin/claude", stderr: "" };
        }
        if (cmd === "sh" && args[1]?.includes("command -v codex")) {
          return { status: 0, stdout: "/usr/bin/codex", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });

    expect(results.find((result) => result.name === "stack")?.message).toContain("Summarizer: auto");
    expect(results.some((result) => result.name === "claude-process")).toBe(true);
    expect(results.some((result) => result.name === "codex-process")).toBe(true);
  });
});
