#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv, exit, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DaemonClient } from "../src/daemon/client.js";
import { lcmHome } from "../src/lcm-home.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { registerMemoryCommands } from "../src/cli/memory.js";
import { registerBenchCommands } from "../src/cli/bench.js";
import { registerConnectorsCommands } from "../src/cli/connectors.js";
import { registerDiagnosticsCommands, registerDiagnoseCommand } from "../src/cli/diagnostics.js";
import { registerHookCommands } from "../src/cli/hooks.js";
import { registerDaemonCommands } from "../src/cli/daemon.js";
import { registerCompactCommand } from "../src/cli/compact.js";
import { registerImportCommand, registerKnowledgeCommands } from "../src/cli/knowledge.js";
import { registerHelpCommand, registerUnknownCommandFallback } from "../src/cli/root.js";
import { registerSetupCommands } from "../src/cli/setup.js";
import { registerSensitiveCommand } from "../src/cli/sensitive.js";

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
  const pidFilePath = createLcmPaths(lcmHome()).pidPath;
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

  const paths = createLcmPaths(lcmHome());
  const config = loadDaemonConfig(paths.configPath);
  const port = config.daemon?.port ?? 3737;
  const pidFilePath = paths.pidPath;
  const tokenPath = paths.tokenPath;
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

  registerHelpCommand(program);

  registerDaemonCommands(program);

  registerCompactCommand(program, { createDaemonClientOrExit });

  registerHookCommands(program);

  registerSetupCommands(program);

  registerDiagnosticsCommands(program, { createDaemonClientOrExit });

  registerMemoryCommands(program, { createDaemonClientOrExit });

  registerDiagnoseCommand(program);

  registerConnectorsCommands(program);

  registerSensitiveCommand(program);

  registerImportCommand(program, { createDaemonClientOrExit });

  registerBenchCommands(program, { admitCliDatabaseWork });

  registerKnowledgeCommands(program, { admitCliDatabaseWork, createDaemonClientOrExit });

  registerUnknownCommandFallback(program);

  // Route hand-written help before Commander validates required positional
  // arguments. Native help remains available for command trees such as bench.
  const args = argv.slice(2);
  const optionBoundary = args.indexOf("--");
  const parsedArgs = optionBoundary === -1 ? args : args.slice(0, optionBoundary);
  const requestedHelp = parsedArgs.at(-1) === "-h" || parsedArgs.at(-1) === "--help";
  if (args.length === 0 || requestedHelp) {
    const { hasCommandHelp, printHelp } = await import("../src/cli-help.js");
    const target = args[0] === "help"
      ? args.slice(1).find((arg) => arg !== "-h" && arg !== "--help")
      : args[0] === "-h" || args[0] === "--help"
        ? undefined
        : args[0];
    if (!target || target === "help" || hasCommandHelp(target)) {
      printHelp(target === "help" ? undefined : target);
      exit(0);
    }
  }

  await program.parseAsync(argv);
}

if (shouldRunMain(argv[1], fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error(err); exit(1); });
}
