import { exit } from "node:process";
import type { Command } from "commander";

export function registerSetupCommands(program: Command): void {
  // ─── mcp ───────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Start the lcm MCP server")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("mcp"); exit(0);
      }
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
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("install"); exit(0);
      }
      const dryRun: boolean = opts.dryRun ?? false;
      const { install } = await import("../../installer/install.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
        console.log("\n  lcm install --dry-run\n");
        await install(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await install();
      }
    });

  // ─── uninstall ─────────────────────────────────────────────────────────────
  program
    .command("uninstall")
    .description("Remove lcm hooks and MCP registration")
    .option("--dry-run", "Preview removals without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("uninstall"); exit(0);
      }
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
