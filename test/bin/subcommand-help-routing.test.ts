import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { helpRequested } from "../../bin/lcm.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

describe("built connector CLI without an agent argument", () => {
  const cli = resolve("dist/bin/lcm.js");
  function invoke(args: string[]) {
    const directory = mkdtempSync(join(tmpdir(), "lcm-help-"));
    try {
      const result = spawnSync(process.execPath, [cli, "connectors", ...args], {
        cwd: directory,
        env: { ...process.env, HOME: directory, LCM_HOME: join(directory, "lcm") },
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(readdirSync(directory)).toEqual([]);
      return result;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([
    ["install", "--help"], ["install", "-h"],
    ["remove", "--help"], ["remove", "-h"],
  ])("connectors %s %s shows help without side effects", (command, flag) => {
    const result = invoke([command, flag]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lcm connectors —");
    expect(result.stderr).toBe("");
  });

  it.each(["install", "remove"])("connectors %s still requires an agent without help", (command) => {
    const result = invoke([command]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/agent/);
    expect(result.stdout).toBe("");
  });
});
