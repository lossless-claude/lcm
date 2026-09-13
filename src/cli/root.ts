import { exit } from "node:process";
import type { Command } from "commander";

export function registerHelpCommand(program: Command): void {
  // ─── help command ──────────────────────────────────────────────────────────
  program
    .command("help [command]")
    .description("Show help for a command")
    .action(async (subcommand?: string) => {
      const { printHelp } = await import("../cli-help.js");
      printHelp(subcommand);
      exit(0);
    });
}

export function registerUnknownCommandFallback(program: Command): void {
  // ─── Unknown command fallback ──────────────────────────────────────────────
  program.on("command:*", async (operands: string[]) => {
    process.stderr.write(`lcm: unknown command '${operands[0]}'\n\n`);
    const { printHelp } = await import("../cli-help.js");
    printHelp();
    exit(1);
  });
}
