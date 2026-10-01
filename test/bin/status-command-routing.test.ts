import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerDiagnosticsCommands } from "../../src/cli/diagnostics.js";

afterEach(() => vi.restoreAllMocks());

it.each([null, 0])("status renders unavailable counts while retaining zero (%s)", async messageCount => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command();
  registerDiagnosticsCommands(program, { createDaemonClientOrExit: async () => ({
    health: async () => ({}),
    post: async () => ({ daemon: { version: "test", uptime: 0, port: 0 },
      project: { messageCount, summaryCount: null, promotedCount: 0 } }),
  }) } as never);
  await program.parseAsync(["status"], { from: "user" });
  expect(log).toHaveBeenCalledWith(`  Messages: ${messageCount === null ? "unavailable" : "0"}`);
  expect(log).toHaveBeenCalledWith("  Summaries: unavailable");
  expect(log).toHaveBeenCalledWith("  Promoted: 0");
});
