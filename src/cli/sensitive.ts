import { exit, stdout } from "node:process";
import type { Command } from "commander";
import { lcmHome } from "../lcm-home.js";
import { createLcmPaths } from "../lcm-paths.js";
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
      const paths = createLcmPaths(lcmHome());
      const r = await handleSensitive(args, process.cwd(), paths);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });
}
