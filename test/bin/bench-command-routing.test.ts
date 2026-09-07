import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBenchCommands } from "../../bin/lcm.js";

describe("benchmark help", () => {
  it.each(["build", "run"])("%s --help stops before its action executes", async (subcommand) => {
    const program = new Command("lcm");
    let output = "";
    program.exitOverride().configureOutput({ writeOut: (text) => { output += text; } });
    registerBenchCommands(program);
    for (const child of program.commands[0].commands) {
      child.exitOverride().configureOutput({ writeOut: (text) => { output += text; } });
    }
    // Bad numeric arguments and missing project DB would fail if the action ran.
    await expect(program.parseAsync([
      "bench", subcommand, "--project", "/nonexistent/lcm-bench-help",
      subcommand === "build" ? "--n" : "--k", "invalid", "--help",
    ], { from: "user" })).rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
    expect(output).toContain(`Usage: lcm bench ${subcommand}`);
    if (subcommand === "build") expect(output).toContain("--generator <mode>");
  });
});
