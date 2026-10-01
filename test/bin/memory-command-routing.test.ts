import { createLcmPaths } from "../../src/lcm-paths.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRunMain } from "../../bin/lcm.js";
import type { DaemonClient } from "../../src/daemon/client.js";
import { registerMemoryCommands } from "../../src/cli/memory.js";

const memoryDeps = { paths: createLcmPaths("/unused"), createDaemonClientOrExit: async () => { throw new Error("not used in this test"); } };

describe("memory command registration", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    ["claude-session", "codex-thread", "claude-session"],
    ["", "codex-thread", "codex-thread"],
    ["", "", "manual"],
  ])("store forwards caller provenance (%s, %s)", async (claude, codex, sessionId) => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", claude);
    vi.stubEnv("CODEX_THREAD_ID", codex);
    vi.stubEnv("LCM_SUMMARIZE_WORKER", "");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const post = vi.fn().mockResolvedValue({ stored: true });
    const program = new Command("lcm");
    registerMemoryCommands(program, {
      paths: createLcmPaths(process.env.LCM_HOME!),
      createDaemonClientOrExit: async () => ({ post }) as DaemonClient,
    });
    await program.parseAsync(["store", "insight", "--tag", "type:decision"], { from: "user" });
    expect(post).toHaveBeenCalledWith("/store", {
      cwd: process.cwd(), text: "insight", tags: ["type:decision"], metadata: { sessionId },
    });
  });

  it("registers all daemon-backed memory commands", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program, memoryDeps);

    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toContain("search");
    expect(commandNames).toContain("grep");
    expect(commandNames).toContain("describe");
    expect(commandNames).toContain("expand");
    expect(commandNames).toContain("store");
  });

  it("search keeps the repeatable layer and tag options", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program, memoryDeps);

    const searchCommand = program.commands.find((command) => command.name() === "search");
    expect(searchCommand).toBeDefined();

    const optionFlags = searchCommand?.options.map((option) => option.flags) ?? [];
    expect(optionFlags).toContain("--layer <name>");
    expect(optionFlags).toContain("--tag <tag>");
    expect(optionFlags).toContain("--limit <n>");
  });

  it("treats symlinked invocation as the same entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-argv-"));
    const target = join(dir, "lcm.js");
    const link = join(dir, "lcm-link.js");

    try {
      writeFileSync(target, "#!/usr/bin/env node\n");
      symlinkSync(target, link);
      expect(shouldRunMain(link, target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shouldRunMain", () => {
  it("returns true when the same path is invoked", () => {
    expect(shouldRunMain("/tmp/lcm.js", "/tmp/lcm.js")).toBe(true);
  });

  it("falls back to direct path comparison when realpath resolution fails", () => {
    expect(shouldRunMain("/nonexistent/lcm.js", "/nonexistent/lcm.js")).toBe(true);
    expect(shouldRunMain("/nonexistent/a.js", "/nonexistent/b.js")).toBe(false);
  });
});