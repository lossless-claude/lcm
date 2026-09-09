import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { helpRequested } from "../../bin/lcm.js";

/**
 * Rebuilds the shape the `daemon` and `connectors` trees have in bin/lcm.ts:
 * a parent that turns off commander's help option and declares its own, and
 * subcommands that do the same. Those commands are registered inside main(),
 * so the shape is reproduced here rather than imported.
 */
function tree(onHelp: (where: string) => void): Command {
  const program = new Command("lcm");
  const parent = new Command("daemon");
  parent.helpOption(false).option("-h, --help", "Show help");
  parent.action((opts) => { if (helpRequested(parent, opts)) onHelp("parent"); else onHelp("parent-action"); });

  const child = parent.command("stop");
  child.helpOption(false).option("-h, --help", "Show help");
  child.action((opts) => { if (helpRequested(parent, opts)) onHelp("help"); else onHelp("ACTION RAN"); });

  program.addCommand(parent);
  return program;
}

describe("--help on a subcommand whose parent declares the same flag", () => {
  it.each(["--help", "-h"])("%s reaches the subcommand instead of running it", (flag) => {
    let where = "";
    tree((w) => { where = w; }).parse(["daemon", "stop", flag], { from: "user" });
    expect(where).toBe("help");
  });

  it("the parent's own --help still works", () => {
    let where = "";
    tree((w) => { where = w; }).parse(["daemon", "--help"], { from: "user" });
    expect(where).toBe("parent");
  });

  it("without --help the subcommand action runs", () => {
    let where = "";
    tree((w) => { where = w; }).parse(["daemon", "stop"], { from: "user" });
    expect(where).toBe("ACTION RAN");
  });
});

describe("helpRequested", () => {
  it("is true when the subcommand itself carries the flag", () => {
    const parent = new Command("daemon");
    expect(helpRequested(parent, { help: true })).toBe(true);
  });

  it("is false when neither carries it", () => {
    const parent = new Command("daemon");
    expect(helpRequested(parent, {})).toBe(false);
  });
});
