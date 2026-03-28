import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";
import { LCM_MD_CONTENT } from "../../src/daemon/orientation.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

vi.mock("../../src/db/events-stats.js", () => ({
  collectEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null }),
  collectDetailedEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] }),
}));

import { collectEventStats } from "../../src/db/events-stats.js";
const mockCollectEventStats = vi.mocked(collectEventStats);

function buildSettingsJson(): string {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, command } of REQUIRED_HOOKS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks, mcpServers: { "lcm": {} } });
}

function buildCleanSettingsJson(): string {
  // No hooks in settings.json — hooks are owned by plugin.json, not settings.json.
  // This produces hooks status: "pass" from the doctor.
  return JSON.stringify({ mcpServers: { "lcm": {} } });
}

function minimalDeps(overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
  return {
    existsSync: () => true,
    readFileSync: (path: string) => {
      if (path.endsWith("config.json")) return "{}";
      if (path.endsWith("settings.json")) return buildCleanSettingsJson();
      if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
      if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
      if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
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
  it("shows gitleaks + native pattern counts as pass when generated-patterns.ts exists", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const detection = results.find((r) => r.name === "secret-detection");
    expect(detection?.status).toBe("pass");
    expect(detection?.message).toContain("gitleaks");
    expect(detection?.message).toContain("native");
    expect(detection?.category).toBe("Security");
  });

  it("shows user pattern counts (no warning when zero project patterns)", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const userPatterns = results.find((r) => r.name === "user-patterns");
    // No warning for zero patterns — just informational
    expect(userPatterns?.status).toBe("pass");
    expect(userPatterns?.category).toBe("Security");
  });
});

describe("runDoctor lcm-md check", () => {
  it("passes when lcm.md exists and CLAUDE.md has managed block", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("lcm.md");
  });

  it("auto-restores and reports fixApplied when lcm.md is missing", async () => {
    const written: Record<string, string> = {};
    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      existsSync: (p: string) => !p.endsWith("lcm.md"),
      writeFileSync: vi.fn((p: string, c: string) => { written[p] = c; }),
    });
    const results = await runDoctor(deps);
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("warn");
    expect(check?.fixApplied).toBe(true);
    expect(written["/tmp/test-home/.claude/lcm.md"]).toBeDefined();
  });
});

describe("runDoctor daemon version mismatch", () => {
  it("auto-restarts daemon on version mismatch and reports fixApplied when post-restart version matches", async () => {
    const pkgVersion = "0.6.0";
    const daemonVersion = "0.5.0";

    // ensureDaemon returns connected on restart attempt
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
      // First fetch: daemon up with old version; second fetch: post-restart with new version
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: pkgVersion }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: pkgVersion }),
    );
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("restarted");
    expect(daemonResult?.message).toContain(daemonVersion);
    expect(daemonResult?.message).toContain(pkgVersion);
  });

  it("reports warn with fixApplied:false when restart does not fix version mismatch", async () => {
    const pkgVersion = "0.6.0";
    const daemonVersion = "0.5.0";

    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
      // Post-restart health still returns old version
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.fixApplied).toBe(false);
    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.message).toContain("did not fix mismatch");
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

describe("Passive Learning checks", () => {
  it("runs passive learning checks when hooks status is warn (auto-fixed duplicates)", async () => {
    // Use deps where hooks check produces "warn" (duplicate hooks in settings.json auto-fixed)
    mockCollectEventStats.mockReturnValue({ captured: 10, unprocessed: 0, errors: 0, lastCapture: null });
    const depsWithBadHooks = minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("settings.json")) return buildSettingsJson(); // duplicate hooks → produces warn
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
    });
    const results = await runDoctor(depsWithBadHooks);
    const plResults = results.filter(r => r.category === "Passive Learning");
    // "warn" status should allow passive learning checks to run
    expect(plResults.length).toBeGreaterThan(0);
  });

  it("warns when hooks installed but no events captured", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("No events captured");
  });

  it("passes when events exist and unprocessed is low", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("pass");
  });

  it("warns when unprocessed > 1000", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 5000, unprocessed: 2000, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("unprocessed");
  });

  it("fails when errors >= 50", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 50, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("fail");
  });

  it("passes errors when 0 errors", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00" });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("pass");
  });

  it("passes staleness when last capture is recent", async () => {
    const now = new Date();
    const recentCapture = now.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: recentCapture });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("pass");
  });

  it("warns staleness when last capture >= 7 days", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldCapture = old.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: oldCapture });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("warn");
    expect(staleness?.message).toContain("hooks may not be firing");
  });
});
