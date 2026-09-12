#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv, exit, stdout } from "node:process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DaemonClient } from "../src/daemon/client.js";
import { lcmHome, lcmPath } from "../src/lcm-home.js";
import { registerMemoryCommands } from "../src/cli/memory.js";
import { registerBenchCommands } from "../src/cli/bench.js";
import { registerConnectorsCommands } from "../src/cli/connectors.js";
import { registerDiagnosticsCommands, registerDiagnoseCommand } from "../src/cli/diagnostics.js";
import { registerHookCommands } from "../src/cli/hooks.js";
import { registerDaemonCommands } from "../src/cli/daemon.js";
import { registerCompactCommand } from "../src/cli/compact.js";
import { registerImportCommand, registerKnowledgeCommands } from "../src/cli/knowledge.js";

export { helpRequested } from "../src/cli/support.js";

export function shouldRunMain(invokedPath: string | undefined, currentFilePath: string): boolean {
  if (!invokedPath) return false;

  try {
    return realpathSync(invokedPath) === realpathSync(currentFilePath);
  } catch {
    return invokedPath === currentFilePath;
  }
}



let cliDaemonActivity: (() => void) | undefined;

async function admitCliDatabaseWork(): Promise<void> {
  const { registerDaemonActivity } = await import("../src/daemon/lifecycle.js");
  const { readHold } = await import("../src/daemon/hold.js");
  const pidFilePath = lcmPath("daemon.pid");
  // Admission covers the whole CLI operation, including offline migrations and
  // replay writes. Exit cleanup also covers explicit exits and action failures.
  if (!cliDaemonActivity) {
    cliDaemonActivity = registerDaemonActivity(pidFilePath);
    process.once("exit", cliDaemonActivity);
  }
  const hold = readHold(pidFilePath);
  if (hold) {
    console.error(`  Daemon held down until ${hold.until}${hold.reason ? ` (${hold.reason})` : ""}. Release it with: lcm daemon start`);
    exit(1);
  }
}

async function createDaemonClientOrExit(spawnTimeoutMs = 5000): Promise<DaemonClient> {
  await admitCliDatabaseWork();
  const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
  const { loadDaemonConfig } = await import("../src/daemon/config.js");

  const config = loadDaemonConfig(lcmPath("config.json"));
  const port = config.daemon?.port ?? 3737;
  const lcDir = lcmHome();
  const pidFilePath = join(lcDir, "daemon.pid");
  const tokenPath = join(lcDir, "daemon.token");
  const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs });

  if (!connected) {
    // A held daemon is down on purpose; saying so keeps it from reading as a fault.
    const { readHold } = await import("../src/daemon/hold.js");
    const hold = readHold(pidFilePath);
    if (hold) {
      console.error(`  Daemon held down until ${hold.until}${hold.reason ? ` (${hold.reason})` : ""}. Release it with: lcm daemon start`);
    } else {
      console.error("  Daemon not available. Start it with: lcm daemon start --detach");
    }
    exit(1);
  }

  return new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);
}

async function main() {
  // PKG_VERSION resolves the package root for both dist/ and source layouts;
  // a hand-rolled `../../package.json` here only worked from dist/.
  const { PKG_VERSION } = await import("../src/daemon/version.js");

  const program = new Command();
  program
    .name("lcm")
    .description("lossless context management for coding agents")
    .version(PKG_VERSION ?? "unknown", "-V, --version")
    .helpCommand(false)
    .addHelpCommand(false)
    .configureOutput({
      writeOut: (str) => stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    });

  // Disable Commander's built-in help entirely — we handle it manually below
  program.helpOption(false);

  // ─── help command ──────────────────────────────────────────────────────────
  program
    .command("help [command]")
    .description("Show help for a command")
    .action(async (subcommand?: string) => {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp(subcommand);
      exit(0);
    });

  registerDaemonCommands(program);

  registerCompactCommand(program, { createDaemonClientOrExit });

  registerHookCommands(program);

  // ─── mcp ───────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Start the lcm MCP server")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("mcp"); exit(0);
      }
      const { startMcpServer } = await import("../src/mcp/server.js");
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
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("install"); exit(0);
      }
      const dryRun: boolean = opts.dryRun ?? false;
      const { install } = await import("../installer/install.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
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
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("uninstall"); exit(0);
      }
      const dryRun: boolean = opts.dryRun ?? false;
      const { uninstall } = await import("../installer/uninstall.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm uninstall --dry-run\n");
        await uninstall(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await uninstall();
      }
    });

  registerDiagnosticsCommands(program, { createDaemonClientOrExit });

  registerMemoryCommands(program, { createDaemonClientOrExit });

  registerDiagnoseCommand(program);

  registerConnectorsCommands(program);

  // ─── sensitive ─────────────────────────────────────────────────────────────
  program
    .command("sensitive [args...]")
    .description("Manage sensitive patterns for automatic redaction")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .allowUnknownOption(true)
    .action(async (args: string[], opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("sensitive"); exit(0);
      }
      const { handleSensitive } = await import("../src/sensitive.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const configPath = lcmPath("config.json");
      const r = await handleSensitive(args, process.cwd(), configPath);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  registerImportCommand(program, { createDaemonClientOrExit });

  registerBenchCommands(program, { admitCliDatabaseWork });

  registerKnowledgeCommands(program, { admitCliDatabaseWork, createDaemonClientOrExit });

  // ─── Unknown command fallback ──────────────────────────────────────────────
  program.on("command:*", async (operands: string[]) => {
    process.stderr.write(`lcm: unknown command '${operands[0]}'\n\n`);
    const { printHelp } = await import("../src/cli-help.js");
    printHelp();
    exit(1);
  });

  // Handle root-level help and no-args before Commander parses — this prevents
  // Commander from seeing --help at the root level and intercepting it before
  // dispatching to subcommands (lcm import --help would otherwise show root help).
  if (argv.length <= 2 || (argv.length === 3 && (argv[2] === "-h" || argv[2] === "--help"))) {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp();
    exit(0);
  }

  await program.parseAsync(argv);
}

if (shouldRunMain(argv[1], fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error(err); exit(1); });
}
