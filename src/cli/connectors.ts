import { exit, stdout } from "node:process";
import { homedir } from "node:os";
import { Command } from "commander";
import { helpRequested } from "./support.js";

export function registerConnectorsCommands(program: Command): void {
  // ─── connectors ────────────────────────────────────────────────────────────
  const connectorsCmd = new Command("connectors").description("Manage connectors for coding agents");
  connectorsCmd.helpOption(false).option("-h, --help", "Show help");
  connectorsCmd.action(async (opts) => {
    if (helpRequested(connectorsCmd, opts)) {
      const { printHelp } = await import("../cli-help.js");
      printHelp("connectors"); exit(0);
    }
    console.error("Usage: lcm connectors <list|install|remove|doctor> [options]");
    exit(1);
  });

  connectorsCmd
    .command("list")
    .description("List available agents and installed connectors")
    .option("--format <format>", "Output format: text or json", "text")
    .option("--global", "Inspect the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (helpRequested(connectorsCmd, opts)) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const format: string = opts.format ?? "text";
      const { listConnectors } = await import("../connectors/installer.js");
      const { AGENTS } = await import("../connectors/registry.js");
      const installed = listConnectors(opts.global ? homedir() : process.cwd());

      if (format === "json") {
        const result = AGENTS.map((a: any) => ({
          id: a.id,
          name: a.name,
          category: a.category,
          defaultType: a.defaultType,
          supportedTypes: a.supportedTypes,
          installed: installed.filter((c: any) => c.agentId === a.id).map((c: any) => c.type),
        }));
        stdout.write(JSON.stringify({ agents: result }, null, 2) + "\n");
      } else {
        console.log("\n  Available agents:\n");
        console.log("  %-20s %-15s %-15s %s", "Agent", "Installed", "Default", "Supported");
        console.log("  " + "─".repeat(70));
        for (const agent of AGENTS) {
          const agentInstalled = installed.filter((c: any) => c.agentId === (agent as any).id);
          const installedStr = (agentInstalled as any[]).length > 0
            ? (agentInstalled as any[]).map((c: any) => c.type).join(", ")
            : "-";
          console.log("  %-20s %-15s %-15s %s",
            (agent as any).name, installedStr, (agent as any).defaultType, (agent as any).supportedTypes.join(", "));
        }
        console.log();
      }
    });

  connectorsCmd
    .command("install [agent]")
    .description("Install a connector for an agent")
    .option("--type <type>", "Connector type: rules, mcp, skill, or hooks")
    .option("--global", "Install into the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string | undefined, opts) => {
      if (helpRequested(connectorsCmd, opts)) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors install <agent> [--type rules|mcp|skill|hooks] [--global]"); exit(1); }
      const type: any = opts.type;
      const { installConnector } = await import("../connectors/installer.js");
      try {
        const result = installConnector(agentName, type, opts.global ? homedir() : process.cwd());
        if ((result as any).manual) {
          console.log(`\n  ${(result as any).manual}\n`);
        } else {
          console.log(`\n  ✓ Installed ${type ?? "default"} connector for ${agentName}`);
          console.log(`    Path: ${(result as any).path}`);
          if ((result as any).requiresRestart) console.log("    Restart the agent to activate.");
          if (result.notice) console.log(`    ${result.notice}`);
          console.log();
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("remove [agent]")
    .description("Remove a connector for an agent")
    .option("--type <type>", "Connector type: rules, mcp, skill, or hooks")
    .option("--global", "Remove from the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string | undefined, opts) => {
      if (helpRequested(connectorsCmd, opts)) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors remove <agent> [--type rules|mcp|skill|hooks] [--global]"); exit(1); }
      const type: any = opts.type;
      const { removeConnector } = await import("../connectors/installer.js");
      try {
        const removed = removeConnector(agentName, type, opts.global ? homedir() : process.cwd());
        if (removed) {
          console.log(`\n  ✓ Removed connector for ${agentName}\n`);
        } else {
          console.log(`\n  No connector found for ${agentName}\n`);
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("doctor [agent]")
    .description("Check connector health")
    .option("--global", "Inspect the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string | undefined, opts) => {
      if (helpRequested(connectorsCmd, opts)) {
        const { printHelp } = await import("../cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const { AGENTS } = await import("../connectors/registry.js");
      const { listConnectors, diagnoseConnector } = await import("../connectors/installer.js");
      const { findAgent } = await import("../connectors/registry.js");
      const found = agentName ? findAgent(agentName) : undefined;
      const agents = found ? [found] : agentName ? [] : AGENTS;

      if (agents.length === 0) { console.error(`  Unknown agent: ${agentName}`); exit(1); }

      const installed = listConnectors(opts.global ? homedir() : process.cwd());
      console.log("\n  Connector health:\n");
      for (const agent of agents) {
        if (agent.id === "codex") {
          const diagnosis = diagnoseConnector("codex", undefined, opts.global ? homedir() : process.cwd());
          console.log(`  ${diagnosis.status === "installed" ? "○" : "⚠"} Codex: ${diagnosis.message}`);
          console.log(`    Path: ${diagnosis.path}`);
          for (const issue of diagnosis.issues) console.log(`    ${issue}`);
        }
        const agentConnectors = installed.filter((c: any) => c.agentId === (agent as any).id);
        if ((agentConnectors as any[]).length === 0) {
          console.log(`  ⚠ ${(agent as any).name}: no connectors installed`);
        } else {
          for (const c of agentConnectors as any[]) {
            if (agent.id === "codex" && c.type === "hooks") continue;
            console.log(`  ✓ ${(agent as any).name}: ${c.type} at ${c.path}`);
          }
        }
      }
      console.log();
    });

  program.addCommand(connectorsCmd);
}
