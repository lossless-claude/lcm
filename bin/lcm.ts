#!/usr/bin/env node
import { argv, exit, stdin, stdout } from "node:process";

const command = argv[2];

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function main() {
  // Handle flags before switch
  if (command === "--version" || command === "-V") {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    stdout.write(pkg.version + "\n");
    exit(0);
  }

  if (command === "--help" || command === "-h" || command === "help") {
    const { printHelp } = await import("../src/cli-help.js");
    // 'lcm help compact' or 'lcm compact --help' both show per-command help
    const subcommand = argv[3] ?? undefined;
    printHelp(subcommand);
    exit(0);
  }

  switch (command) {
    case "daemon": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("daemon"); exit(0);
      }
      if (argv[3] === "start") {
        if (argv.includes("--detach")) {
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
      }
      break;
    }
    case "compact": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("compact"); exit(0);
      }
      const all = argv.includes("--all");
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
        const dryRun = argv.includes("--dry-run");
        const replay = argv.includes("--replay");
        const noPromote = argv.includes("--no-promote");
        const verbose = argv.includes("--verbose") || argv.includes("-v");
        const minTokens = config.compaction.autoCompactMinTokens;
        const cwd = all ? undefined : process.cwd();
        const { compacted } = await batchCompact({ minTokens, dryRun, port, cwd, replay, verbose });

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

        break;
      }
    }
    // falls through to hook dispatch (piped stdin = PreCompact hook invocation)
    case "restore":
    case "session-end":
    case "user-prompt": {
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook(command, input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
    case "mcp": {
      const { startMcpServer } = await import("../src/mcp/server.js");
      await startMcpServer();
      break;
    }
    case "install": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("install"); exit(0);
      }
      const dryRun = argv.includes("--dry-run");
      const { install } = await import("../installer/install.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm install --dry-run\n");
        await install(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await install();
      }
      break;
    }
    case "uninstall": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("uninstall"); exit(0);
      }
      const dryRun = argv.includes("--dry-run");
      const { uninstall } = await import("../installer/uninstall.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm uninstall --dry-run\n");
        await uninstall(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await uninstall();
      }
      break;
    }
    case "status": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("status"); exit(0);
      }
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const jsonFlag = argv.includes("--json");

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
      break;
    }
    case "stats": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("stats"); exit(0);
      }
      const verbose = argv.includes("--verbose") || argv.includes("-v");
      const { collectStats, printStats } = await import("../src/stats.js");
      printStats(collectStats(), verbose);
      break;
    }
    case "doctor": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("doctor"); exit(0);
      }
      const { runDoctor, printResults } = await import("../src/doctor/doctor.js");
      const results = await runDoctor();
      printResults(results);
      const failures = results.filter((r: { status: string }) => r.status === "fail");
      exit(failures.length > 0 ? 1 : 0);
      break;
    }
    case "diagnose": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("diagnose"); exit(0);
      }
      const all = argv.includes("--all");
      const verbose = argv.includes("--verbose");
      const json = argv.includes("--json");
      const daysIndex = argv.indexOf("--days");
      const daysValue = daysIndex !== -1 ? argv[daysIndex + 1] : undefined;
      const days = daysValue ? Number(daysValue) : 7;

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
      break;
    }
    case "connectors": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const sub = argv[3];
      switch (sub) {
        case "list": {
          const format = argv.includes("--format") ? argv[argv.indexOf("--format") + 1] : "text";
          const { listConnectors } = await import("../src/connectors/installer.js");
          const { AGENTS } = await import("../src/connectors/registry.js");
          const installed = listConnectors();


          if (format === "json") {
            const result = AGENTS.map(a => ({
              id: a.id,
              name: a.name,
              category: a.category,
              defaultType: a.defaultType,
              supportedTypes: a.supportedTypes,
              installed: installed.filter(c => c.agentId === a.id).map(c => c.type),
            }));
            stdout.write(JSON.stringify({ agents: result }, null, 2) + "\n");
          } else {
            console.log("\n  Available agents:\n");
            console.log("  %-20s %-15s %-15s %s", "Agent", "Installed", "Default", "Supported");
            console.log("  " + "─".repeat(70));
            for (const agent of AGENTS) {
              const agentInstalled = installed.filter(c => c.agentId === agent.id);
              const installedStr = agentInstalled.length > 0
                ? agentInstalled.map(c => c.type).join(", ")
                : "-";
              console.log("  %-20s %-15s %-15s %s",
                agent.name, installedStr, agent.defaultType, agent.supportedTypes.join(", "));
            }
            console.log();
          }
          break;
        }
        case "install": {
          const agentName = argv.slice(4).filter(a => !a.startsWith("--")).join(" ");
          if (!agentName) { console.error("Usage: lcm connectors install <agent> [--type rules|mcp|skill]"); exit(1); }
          const typeIdx = argv.indexOf("--type");
          const type = typeIdx !== -1 ? argv[typeIdx + 1] as any : undefined;
          const { installConnector } = await import("../src/connectors/installer.js");
          try {
            const result = installConnector(agentName, type);
            if (result.manual) {
              console.log(`\n  ${result.manual}\n`);
            } else {
              console.log(`\n  ✓ Installed ${type ?? "default"} connector for ${agentName}`);
              console.log(`    Path: ${result.path}`);
              if (result.requiresRestart) console.log("    Restart the agent to activate.");
              console.log();
            }
          } catch (err: any) {
            console.error(`  Error: ${err.message}`);
            exit(1);
          }
          break;
        }
        case "remove": {
          const agentName = argv.slice(4).filter(a => !a.startsWith("--")).join(" ");
          if (!agentName) { console.error("Usage: lcm connectors remove <agent> [--type rules|mcp|skill]"); exit(1); }
          const typeIdx = argv.indexOf("--type");
          const type = typeIdx !== -1 ? argv[typeIdx + 1] as any : undefined;
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
          break;
        }
        case "doctor": {
          const agentName = argv.slice(4).filter(a => !a.startsWith("--")).join(" ");
          const { AGENTS } = await import("../src/connectors/registry.js");
          const { listConnectors } = await import("../src/connectors/installer.js");
          const { findAgent } = await import("../src/connectors/registry.js");
          const found = agentName ? findAgent(agentName) : undefined;
          const agents = found ? [found] : agentName ? [] : AGENTS;

          if (agents.length === 0) { console.error(`  Unknown agent: ${agentName}`); exit(1); }

          const installed = listConnectors();
          console.log("\n  Connector health:\n");
          for (const agent of agents) {
            const agentConnectors = installed.filter((c: any) => c.agentId === agent.id);
            if (agentConnectors.length === 0) {
              console.log(`  ⚠ ${agent.name}: no connectors installed`);
            } else {
              for (const c of agentConnectors) {
                console.log(`  ✓ ${agent.name}: ${c.type} at ${c.path}`);
              }
            }
          }
          console.log();
          break;
        }
        default:
          console.error("Usage: lcm connectors <list|install|remove|doctor> [options]");
          exit(1);
      }
      break;
    }
    case "sensitive": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("sensitive"); exit(0);
      }
      const { handleSensitive } = await import("../src/sensitive.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const configPath = join(homedir(), ".lossless-claude", "config.json");
      const r = await handleSensitive(argv.slice(3), process.cwd(), configPath);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
    case "import": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import"); exit(0);
      }
      const all = argv.includes("--all");
      const verbose = argv.includes("--verbose");
      const dryRun = argv.includes("--dry-run");
      const replay = argv.includes("--replay");

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
      break;
    }
    case "promote": {
      if (argv.includes("--help") || argv.includes("-h")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("promote"); exit(0);
      }
      const all = argv.includes("--all");
      const verbose = argv.includes("--verbose");
      const dryRun = argv.includes("--dry-run");

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
      const total = cwds.length;

      for (let i = 0; i < cwds.length; i++) {
        const cwd = cwds[i];
        if (total > 1) {
          process.stdout.write(`\r  scanning project ${i + 1}/${total}...`);
        } else {
          process.stdout.write(`\r  scanning...`);
        }

        const res = await fetch(`${baseUrl}/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, dry_run: dryRun }),
        });

        if (!res.ok) {
          if (verbose) console.error(`  promote failed for ${cwd}: ${res.status}`);
          continue;
        }

        const result = await res.json() as { processed: number; promoted: number; conversations?: number };
        totalProcessed += result.processed;
        totalPromoted += result.promoted;

        if (verbose) {
          process.stdout.write("\r");
          const convLabel = result.conversations !== undefined ? `, ${result.conversations} conversation${result.conversations !== 1 ? "s" : ""}` : "";
          console.log(`  ${cwd}: ${result.processed} scanned${convLabel}, ${result.promoted} promoted`);
        }
      }
      // Clear the progress line
      process.stdout.write("\r  \r");

      if (totalPromoted === 0) {
        console.log("  Nothing to promote — no new insights found.");
      } else {
        console.log(`  ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted to long-term memory`);
      }
      if (verbose) console.log(`  (${totalProcessed} summaries scanned across ${cwds.length} project${cwds.length !== 1 ? "s" : ""})`);
      if (dryRun) console.log("  [dry-run] No changes written.");
      console.log();
      break;
    }
    default: {
      const { printHelp } = await import("../src/cli-help.js");
      if (command) {
        process.stderr.write(`lcm: unknown command '${command}'\n\n`);
      }
      printHelp();
      exit(command ? 1 : 0);
    }
  }
}

main().catch((err) => { console.error(err); exit(1); });
