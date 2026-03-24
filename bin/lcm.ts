#!/usr/bin/env node
import { argv, exit, stdin, stdout } from "node:process";
import { Command } from "commander";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function withCustomHelp(cmd: Command, commandName: string): Promise<void> {
  const { printHelp } = await import("../src/cli-help.js");
  printHelp(commandName);
  exit(0);
}

async function main() {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  const program = new Command();
  program
    .name("lcm")
    .description("lossless context management for Claude Code")
    .version(pkg.version, "-V, --version")
    .helpCommand(false)
    .addHelpCommand(false)
    .configureOutput({
      writeOut: (str) => stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    });

  // Override default --help to use custom help
  program.helpOption(false);
  program.option("-h, --help", "Show help").hook("preAction", async () => {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp();
    exit(0);
  });

  // ─── help command ──────────────────────────────────────────────────────────
  program
    .command("help [command]")
    .description("Show help for a command")
    .action(async (subcommand?: string) => {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp(subcommand);
      exit(0);
    });

  // ─── daemon ────────────────────────────────────────────────────────────────
  const daemonCmd = new Command("daemon").description("Start the context daemon");
  daemonCmd.helpOption(false).option("-h, --help", "Show help");
  daemonCmd.command("start")
    .description("Start the context daemon")
    .option("--detach", "Run in the background")
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) { await withCustomHelp(daemonCmd, "daemon"); return; }
      if (opts.detach) {
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, [process.argv[1], "daemon", "start"], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.unref();
        if (child.pid) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const lcDir = join(homedir(), ".lossless-claude");
          mkdirSync(lcDir, { recursive: true });
          writeFileSync(join(lcDir, "daemon.pid"), String(child.pid));
          console.log(`lcm daemon started in background (PID ${child.pid})`);
        }
        exit(0);
      }
      const { createDaemon } = await import("../src/daemon/server.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const daemon = await createDaemon(config);
      console.log(`lcm daemon started on port ${daemon.address().port}`);
      process.on("SIGTERM", () => exit(0));
      process.on("SIGINT", () => exit(0));
    });
  daemonCmd.action(async (opts) => {
    if (opts.help) { await withCustomHelp(daemonCmd, "daemon"); return; }
  });
  program.addCommand(daemonCmd);

  // ─── compact ───────────────────────────────────────────────────────────────
  program
    .command("compact")
    .description("Compact conversation context into DAG summary nodes")
    .option("--all", "Compact all tracked projects")
    .option("--dry-run", "Show what would be compacted without writing")
    .option("--replay", "Compact sequentially with threaded context")
    .option("--no-promote", "Skip the automatic promote step")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("compact"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      // Interactive batch compact: --all (all projects) or TTY stdin (current project only).
      // If stdin is piped (hook invocation), fall through to hook dispatch.
      if (all || process.stdin.isTTY) {
        const { batchCompact } = await import("../src/batch-compact.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
        const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
        const port = config.daemon?.port ?? 3737;
        const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
        const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 10000 });
        if (!connected) {
          console.error("Could not connect to daemon. Start it with: lcm daemon start --detach");
          exit(1);
        }
        const dryRun: boolean = opts.dryRun ?? false;
        const replay: boolean = opts.replay ?? false;
        const noPromote: boolean = !opts.promote;
        const minTokens = config.compaction.autoCompactMinTokens;
        const cwd = all ? undefined : process.cwd();
        const { compacted } = await batchCompact({ minTokens, dryRun, port, cwd, replay });

        // Auto-promote after a successful compact: new summaries are prime promotion candidates.
        if (compacted > 0 && !noPromote) {
          const { readdirSync, existsSync, readFileSync } = await import("node:fs");
          const promoteCwds: string[] = [];
          if (cwd) {
            promoteCwds.push(cwd);
          } else {
            const projectsDir = join(homedir(), ".lossless-claude", "projects");
            if (existsSync(projectsDir)) {
              for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const metaPath = join(projectsDir, entry.name, "meta.json");
                if (!existsSync(metaPath)) continue;
                try {
                  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
                  if (meta.cwd) promoteCwds.push(meta.cwd);
                } catch { /* skip unreadable */ }
              }
            }
          }

          let totalPromoted = 0;
          for (const promoteCwd of promoteCwds) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/promote`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cwd: promoteCwd, dry_run: dryRun }),
              });
              if (res.ok) {
                const result = await res.json() as { processed: number; promoted: number };
                totalPromoted += result.promoted;
              }
            } catch { /* non-fatal: promote is best-effort */ }
          }

          if (totalPromoted > 0) {
            console.log(`  → ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted`);
          }
        }
        return;
      }
      // Piped stdin — hook dispatch (PreCompact hook invocation)
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("compact", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── restore (hook) ────────────────────────────────────────────────────────
  program
    .command("restore")
    .description("Dispatch the restore hook")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("restore"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("restore", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-end (hook) ────────────────────────────────────────────────────
  program
    .command("session-end")
    .description("Dispatch the session-end hook")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("session-end"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("session-end", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── user-prompt (hook) ────────────────────────────────────────────────────
  program
    .command("user-prompt")
    .description("Dispatch the user-prompt hook")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("user-prompt"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("user-prompt", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

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

  // ─── status ────────────────────────────────────────────────────────────────
  program
    .command("status")
    .description("Show daemon status and project memory statistics")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("status"); exit(0);
      }
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const jsonFlag: boolean = opts.json ?? false;

      let daemonStatus = "down";
      let statusData: any = null;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) daemonStatus = "up";

        // Also fetch /status endpoint if daemon is up
        if (daemonStatus === "up") {
          const statusRes = await fetch(`http://127.0.0.1:${port}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: process.cwd() }),
          });
          if (statusRes.ok) {
            statusData = await statusRes.json();
          }
        }
      } catch {}

      if (jsonFlag) {
        const result = {
          daemon: daemonStatus === "up" ? statusData?.daemon : { status: "down" },
          project: statusData?.project,
        };
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const provider = config.llm?.provider ?? "unknown";
        const providerDisplay = provider === "auto"
          ? "auto (Claude->claude-process, Codex->codex-process)"
          : provider;

        if (statusData) {
          console.log(`Daemon: ${daemonStatus}`);
          console.log(`  Version: ${statusData.daemon.version}`);
          console.log(`  Uptime: ${statusData.daemon.uptime}s`);
          console.log(`  Port: ${statusData.daemon.port}`);
          console.log(`  Provider: ${providerDisplay}`);
          console.log();
          console.log("Project:");
          console.log(`  Messages: ${statusData.project.messageCount}`);
          console.log(`  Summaries: ${statusData.project.summaryCount}`);
          console.log(`  Promoted: ${statusData.project.promotedCount}`);
          if (statusData.project.lastIngest) console.log(`  Last Ingest: ${statusData.project.lastIngest}`);
          if (statusData.project.lastCompact) console.log(`  Last Compact: ${statusData.project.lastCompact}`);
          if (statusData.project.lastPromote) console.log(`  Last Promote: ${statusData.project.lastPromote}`);
        } else {
          console.log(`daemon: ${daemonStatus} · provider: ${providerDisplay}`);
        }
      }
    });

  // ─── stats ─────────────────────────────────────────────────────────────────
  program
    .command("stats")
    .description("Show memory inventory and compression ratios")
    .option("-v, --verbose", "Show per-conversation breakdown")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("stats"); exit(0);
      }
      const verbose: boolean = opts.verbose ?? false;
      const { collectStats, printStats } = await import("../src/stats.js");
      printStats(collectStats(), verbose);
    });

  // ─── doctor ────────────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Run diagnostics: daemon, hooks, MCP, summarizer")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("doctor"); exit(0);
      }
      const { runDoctor, printResults } = await import("../src/doctor/doctor.js");
      const results = await runDoctor();
      printResults(results);
      const failures = results.filter((r: { status: string }) => r.status === "fail");
      exit(failures.length > 0 ? 1 : 0);
    });

  // ─── diagnose ──────────────────────────────────────────────────────────────
  program
    .command("diagnose")
    .description("Scan recent sessions for hook failures and issues")
    .option("--all", "Scan all tracked projects")
    .option("--days <n>", "Scan the last N days (default: 7)", "7")
    .option("--verbose", "Include full event details")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("diagnose"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const json: boolean = opts.json ?? false;
      const days = Number(opts.days);

      if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
        console.error("Usage: lcm diagnose [--all] [--days N] [--verbose] [--json]");
        exit(1);
      }

      const { diagnose, formatDiagnoseResult } = await import("../src/diagnose.js");
      const result = await diagnose({ all, days, verbose });

      if (json) {
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        stdout.write(formatDiagnoseResult(result, { days, verbose }));
      }
    });

  // ─── connectors ────────────────────────────────────────────────────────────
  const connectorsCmd = new Command("connectors").description("Manage connectors for coding agents");
  connectorsCmd.helpOption(false).option("-h, --help", "Show help");
  connectorsCmd.action(async (opts) => {
    if (opts.help) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("connectors"); exit(0);
    }
    console.error("Usage: lcm connectors <list|install|remove|doctor> [options]");
    exit(1);
  });

  connectorsCmd
    .command("list")
    .description("List available agents and installed connectors")
    .option("--format <format>", "Output format: text or json", "text")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const format: string = opts.format ?? "text";
      const { listConnectors } = await import("../src/connectors/installer.js");
      const { AGENTS } = await import("../src/connectors/registry.js");
      const installed = listConnectors();

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
    .command("install <agent>")
    .description("Install a connector for an agent")
    .option("--type <type>", "Connector type: rules, mcp, or skill")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors install <agent> [--type rules|mcp|skill]"); exit(1); }
      const type: any = opts.type;
      const { installConnector } = await import("../src/connectors/installer.js");
      try {
        const result = installConnector(agentName, type);
        if ((result as any).manual) {
          console.log(`\n  ${(result as any).manual}\n`);
        } else {
          console.log(`\n  ✓ Installed ${type ?? "default"} connector for ${agentName}`);
          console.log(`    Path: ${(result as any).path}`);
          if ((result as any).requiresRestart) console.log("    Restart the agent to activate.");
          console.log();
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("remove <agent>")
    .description("Remove a connector for an agent")
    .option("--type <type>", "Connector type: rules, mcp, or skill")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors remove <agent> [--type rules|mcp|skill]"); exit(1); }
      const type: any = opts.type;
      const { removeConnector } = await import("../src/connectors/installer.js");
      try {
        const removed = removeConnector(agentName, type);
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
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string | undefined, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const { AGENTS } = await import("../src/connectors/registry.js");
      const { listConnectors } = await import("../src/connectors/installer.js");
      const { findAgent } = await import("../src/connectors/registry.js");
      const found = agentName ? findAgent(agentName) : undefined;
      const agents = found ? [found] : agentName ? [] : AGENTS;

      if (agents.length === 0) { console.error(`  Unknown agent: ${agentName}`); exit(1); }

      const installed = listConnectors();
      console.log("\n  Connector health:\n");
      for (const agent of agents) {
        const agentConnectors = installed.filter((c: any) => c.agentId === (agent as any).id);
        if ((agentConnectors as any[]).length === 0) {
          console.log(`  ⚠ ${(agent as any).name}: no connectors installed`);
        } else {
          for (const c of agentConnectors as any[]) {
            console.log(`  ✓ ${(agent as any).name}: ${c.type} at ${c.path}`);
          }
        }
      }
      console.log();
    });

  program.addCommand(connectorsCmd);

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
      const configPath = join(homedir(), ".lossless-claude", "config.json");
      const r = await handleSensitive(args, process.cwd(), configPath);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── import ────────────────────────────────────────────────────────────────
  program
    .command("import")
    .description("Import Claude Code session transcripts into lossless memory")
    .option("--all", "Import all projects")
    .option("--verbose", "Show per-session import detail")
    .option("--dry-run", "Preview without importing")
    .option("--replay", "Replay compaction for each imported session")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const replay: boolean = opts.replay ?? false;

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { importSessions } = await import("../src/import.js");
      const { printImportSummary } = await import("../src/import-summary.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
      const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 5000 });
      if (!connected) { console.error("  Daemon not available"); exit(1); }

      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      console.log(`\n  Importing Claude Code sessions${all ? " (all projects)" : ""}...\n`);

      const result = await importSessions(client, { all, verbose, dryRun, replay });

      if (dryRun) console.log("  [dry-run] No changes written.\n");
      printImportSummary(result, { replay });
      console.log();
    });

  // ─── promote ───────────────────────────────────────────────────────────────
  program
    .command("promote")
    .description("Scan summaries and promote durable insights to long-term memory")
    .option("--all", "Promote across all tracked projects")
    .option("--verbose", "Show per-project counts")
    .option("--dry-run", "Preview promotions without writing")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("promote"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const dryRun: boolean = opts.dryRun ?? false;

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
      const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 5000 });
      if (!connected) {
        console.error("  Daemon not available. Start it with: lcm daemon start --detach");
        exit(1);
      }

      const baseUrl = `http://127.0.0.1:${port}`;
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");

      if (dryRun) console.log("  [dry-run] No changes will be written.\n");

      // Collect project cwds to promote
      const cwds: string[] = [];
      if (all) {
        const projectsDir = join(homedir(), ".lossless-claude", "projects");
        if (existsSync(projectsDir)) {
          for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = join(projectsDir, entry.name, "meta.json");
            if (!existsSync(metaPath)) continue;
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta.cwd) cwds.push(meta.cwd);
            } catch { /* skip unreadable */ }
          }
        }
      } else {
        cwds.push(process.cwd());
      }

      let totalProcessed = 0;
      let totalPromoted = 0;

      for (const cwd of cwds) {
        const res = await fetch(`${baseUrl}/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, dry_run: dryRun }),
        });

        if (!res.ok) {
          if (verbose) console.error(`  promote failed for ${cwd}: ${res.status}`);
          continue;
        }

        const result = await res.json() as { processed: number; promoted: number };
        totalProcessed += result.processed;
        totalPromoted += result.promoted;

        if (verbose) {
          console.log(`  ${cwd}: ${result.processed} scanned, ${result.promoted} promoted`);
        }
      }

      if (totalPromoted === 0) {
        console.log("  Nothing to promote — no new insights found.");
      } else {
        console.log(`  ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted to long-term memory`);
      }
      if (verbose) console.log(`  (${totalProcessed} summaries scanned across ${cwds.length} project${cwds.length !== 1 ? "s" : ""})`);
      if (dryRun) console.log("  [dry-run] No changes written.");
      console.log();
    });

  // ─── Unknown command fallback ──────────────────────────────────────────────
  program.on("command:*", async (operands: string[]) => {
    process.stderr.write(`lcm: unknown command '${operands[0]}'\n\n`);
    const { printHelp } = await import("../src/cli-help.js");
    printHelp();
    exit(1);
  });

  // Override program-level --help to show custom help
  program.on("option:help", async () => {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp();
    exit(0);
  });

  // Parse with allowUnknownOption to avoid Commander erroring before our handler
  await program.parseAsync(argv);

  // If no command was given, show help
  if (argv.length <= 2) {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp();
    exit(0);
  }
}

main().catch((err) => { console.error(err); exit(1); });
