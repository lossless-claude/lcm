import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli-help.js";
import { registerImportCommand } from "../src/cli/knowledge.js";
import { registerDiagnosticsCommands } from "../src/cli/diagnostics.js";
import { lcmHome } from "../src/lcm-home.js";
import { createLcmPaths } from "../src/lcm-paths.js";

vi.mock("../src/cli/support.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/cli/support.js")>(),
  fail: (message: string) => { throw new Error(message); },
}));
afterEach(() => vi.restoreAllMocks());

function command() {
  const post = vi.fn().mockResolvedValue({ cleared: 2 });
  const createClient = vi.fn().mockResolvedValue({ post });
  const program = new Command().exitOverride();
  registerImportCommand(program, { createDaemonClientOrExit: createClient });
  return { post, createClient, program };
}

describe("import --retry-blocked", () => {
  it("documents retry scopes and preserved history under import", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("import");
    const text = output.mock.calls.map(call => call[0]).join("");
    expect(text).toContain("--retry-blocked");
    expect(text).toContain("Stored messages and summaries are preserved");
    expect(text).toContain("every project with a project record");
    const program = new Command();
    registerDiagnosticsCommands(program, { createDaemonClientOrExit: vi.fn() });
    expect(program.commands.map(c => c.name())).not.toContain("capture-retry");
  });

  it.each([
    [[], { all: true }],
    [["--session", "child"], { session_id: "child" }],
  ])("clears the requested current-project guards through the daemon: %s", async (args, scope) => {
    const { program, post } = command();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["import", "--provider", "codex", "--retry-blocked", ...args], { from: "user" });
    expect(post).toHaveBeenCalledExactlyOnceWith("/capture-retry", { cwd: process.cwd(), ...scope });
    expect(output).toHaveBeenCalledWith("Cleared 2 terminal Codex guards; the next capture will recheck alignment.");
  });

  it("clears guards for every recorded project that still exists and prints the projects that had any", async () => {
    const paths = createLcmPaths(lcmHome());
    const cwds = [join(lcmHome(), "project-a"), join(lcmHome(), "project-b")];
    const vanished = join(lcmHome(), "project-gone");
    for (const [i, cwd] of [...cwds, vanished].entries()) {
      const dir = join(paths.projectsDir, String(i));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd }));
    }
    for (const cwd of cwds) mkdirSync(cwd, { recursive: true });
    mkdirSync(join(paths.projectsDir, "no-record"), { recursive: true });
    const { program, post } = command();
    post.mockResolvedValueOnce({ cleared: 2 }).mockResolvedValueOnce({ cleared: 0 });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["import", "--provider", "codex", "--retry-blocked", "--all"], { from: "user" });
    expect(post.mock.calls).toEqual(cwds.map(cwd => ["/capture-retry", { cwd, all: true }]));
    expect(output).toHaveBeenCalledWith(`${cwds[0]}: cleared 2`);
    expect(output).not.toHaveBeenCalledWith(`${cwds[1]}: cleared 0`);
    expect(output).toHaveBeenCalledWith("Cleared 2 terminal Codex guards; the next capture will recheck alignment.");
  });

  it.each([
    [[], "requires --provider codex"],
    [["--provider", "claude"], "requires --provider codex"],
    [["--provider", "omp"], "requires --provider codex"],
    [["--provider", "all"], "requires --provider codex"],
    [["--provider", "codex", "--replay"], "cannot be combined with --replay"],
    [["--provider", "codex", "--rebuild"], "cannot be combined with --replay"],
    [["--provider", "codex", "--dry-run"], "cannot be combined with --replay"],
    [["--provider", "codex", "--all", "--session", "child"], "--all and --session cannot be combined"],
    [["--provider", "codex", "--session", " "], "--session must not be empty"],
    [["--provider", "codex", "--yes"], "--yes applies only with --rebuild"],
  ])("rejects invalid retry options before starting the daemon: %s", async (args, message) => {
    const { program, createClient, post } = command();
    await expect(program.parseAsync(["import", "--retry-blocked", ...args], { from: "user" })).rejects.toThrow(message);
    expect(createClient).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
