import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRunMain } from "../../bin/lcm.js";
import { registerMemoryCommands } from "../../src/cli/memory.js";

const memoryDeps = { createDaemonClientOrExit: async () => { throw new Error("not used in this test"); } };

describe("memory command registration", () => {
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