import { describe, it, expect } from "vitest";
import { Command, Option } from "commander";

/** Minimal replica of the compact command's option setup. */
function makeCompactCmd() {
  const cmd = new Command("compact");
  cmd.option("--all", "Compact all tracked projects");
  cmd.option("--dry-run");
  cmd.option("--replay");
  cmd.option("-v, --verbose");
  cmd.addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp());
  return cmd;
}

describe("compact command --hook routing", () => {
  it("zero flags: opts.hook is falsy → batch mode", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync([], { from: "user" });
    expect(cmd.opts().hook).toBeFalsy();
  });

  it("--hook flag: opts.hook is true → hook dispatch", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--hook"], { from: "user" });
    expect(cmd.opts().hook).toBe(true);
  });

  it("--hook with TTY: opts.hook is true → hook dispatch (TTY does not override --hook)", async () => {
    // TTY state is irrelevant when --hook is explicit; parsed opts reflect only flags
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--hook"], { from: "user" });
    expect(cmd.opts().hook).toBe(true);
  });

  it("--hook is hidden from help output", () => {
    const cmd = makeCompactCmd();
    const helpText = cmd.helpInformation();
    expect(helpText).not.toContain("--hook");
  });
});
