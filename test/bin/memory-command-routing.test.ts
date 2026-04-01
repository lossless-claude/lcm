import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerMemoryCommands } from "../../bin/lcm.js";

describe("memory command registration", () => {
  it("registers all daemon-backed memory commands", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program);

    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toContain("search");
    expect(commandNames).toContain("grep");
    expect(commandNames).toContain("describe");
    expect(commandNames).toContain("expand");
    expect(commandNames).toContain("store");
  });

  it("search keeps the repeatable layer and tag options", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program);

    const searchCommand = program.commands.find((command) => command.name() === "search");
    expect(searchCommand).toBeDefined();

    const optionFlags = searchCommand?.options.map((option) => option.flags) ?? [];
    expect(optionFlags).toContain("--layer <name>");
    expect(optionFlags).toContain("--tag <tag>");
    expect(optionFlags).toContain("--limit <n>");
  });
});