import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli-help.js";
import { registerDiagnosticsCommands } from "../src/cli/diagnostics.js";

describe("capture-retry command", () => {
  it("documents the two retry scopes and preserved history", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printHelp("capture-retry");
      const text = output.mock.calls.map(call => call[0]).join("");
      expect(text).toContain("lcm capture-retry --session <id> | --all");
      expect(text).toContain("Stored messages and summaries are preserved");
      expect(error).not.toHaveBeenCalled();
    } finally { output.mockRestore(); error.mockRestore(); }
  });

  it.each([[["--session", "child"], { session_id: "child" }], [["--all"], { all: true }]])(
    "clears the requested project guards through the daemon: %s", async (args, scope) => {
      const post = vi.fn().mockResolvedValue({ cleared: 2 });
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const program = new Command().exitOverride();
        registerDiagnosticsCommands(program, { createDaemonClientOrExit: vi.fn().mockResolvedValue({ post }) });
        await program.parseAsync(["capture-retry", ...args], { from: "user" });
        expect(post).toHaveBeenCalledWith("/capture-retry", { cwd: process.cwd(), ...scope });
        expect(output).toHaveBeenCalledWith("Cleared 2 terminal Codex guards; the next capture will recheck alignment.");
      } finally { output.mockRestore(); }
    },
  );
});
