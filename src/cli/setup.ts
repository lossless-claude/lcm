import { exit } from "node:process";
import type { Command } from "commander";
import type { InstallOutcome } from "../../installer/install.js";
import { showHelpAndExit } from "./support.js";

export function registerSetupCommands(program: Command): void {
  // ─── mcp ───────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Start the lcm MCP server")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) await showHelpAndExit("mcp");
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer();
    });

  // ─── install ───────────────────────────────────────────────────────────────
  program
    .command("install")
    .description("Set up lcm: register hooks, configure daemon, connect MCP")
    .option("--dry-run", "Preview all changes without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) await showHelpAndExit("install");
      const dryRun: boolean = opts.dryRun ?? false;
      const { install } = await import("../../installer/install.js");
      let outcome: InstallOutcome;
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
        console.log("\n  lcm install --dry-run\n");
        outcome = await install(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        outcome = await install();
      }
      // One outcome per harness; any failed harness makes the command fail.
      if (Object.values(outcome).some((o) => o.status === "failed")) exit(1);
    });

  // ─── uninstall ─────────────────────────────────────────────────────────────
  program
    .command("uninstall")
    .description("Remove lcm hooks and MCP registration")
    .option("--dry-run", "Preview removals without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) await showHelpAndExit("uninstall");
      const dryRun: boolean = opts.dryRun ?? false;
      const { uninstall } = await import("../../installer/uninstall.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
        console.log("\n  lcm uninstall --dry-run\n");
        await uninstall(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await uninstall();
      }
    });
}
