import { exit, stdout } from "node:process";
import type { Command } from "commander";
import { lcmPath } from "../lcm-home.js";
import { showHelpAndExit } from "./support.js";

export function registerSensitiveCommand(program: Command): void {
  // ─── sensitive ─────────────────────────────────────────────────────────────
  program
    .command("sensitive [args...]")
    .description("Manage sensitive patterns for automatic redaction")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .allowUnknownOption(true)
    .action(async (args: string[], opts) => {
      if (opts.help) await showHelpAndExit("sensitive");
      const { handleSensitive } = await import("../sensitive.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const configPath = lcmPath("config.json");
      const r = await handleSensitive(args, process.cwd(), configPath);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });
}
