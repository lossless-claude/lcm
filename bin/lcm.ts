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
  if (command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    stdout.write(pkg.version + "\n");
    exit(0);
  }

  switch (command) {
    case "daemon": {
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
      if (argv.includes("--all")) {
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
        const minTokens = config.compaction.autoCompactMinTokens;
        await batchCompact({ minTokens, dryRun, port });
        break;
      }
    }
    // falls through to hook dispatch
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
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;

      let daemonStatus = "down";
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) daemonStatus = "up";
      } catch {}

      const provider = config.llm?.provider ?? "unknown";
      const providerDisplay = provider === "auto"
        ? "auto (Claude->claude-process, Codex->codex-process)"
        : provider;
      console.log(`daemon: ${daemonStatus} · provider: ${providerDisplay}`);
      break;
    }
    case "stats": {
      const verbose = argv.includes("--verbose") || argv.includes("-v");
      const { collectStats, printStats } = await import("../src/stats.js");
      printStats(collectStats(), verbose);
      break;
    }
    case "doctor": {
      const { runDoctor, printResults } = await import("../src/doctor/doctor.js");
      const results = await runDoctor();
      printResults(results);
      const failures = results.filter((r: { status: string }) => r.status === "fail");
      exit(failures.length > 0 ? 1 : 0);
      break;
    }
    case "diagnose": {
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
      const all = argv.includes("--all");
      const verbose = argv.includes("--verbose");
      const dryRun = argv.includes("--dry-run");

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { importSessions } = await import("../src/import.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
      const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 5000 });
      if (!connected) { console.error("  Daemon not available"); exit(1); }

      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      console.log(`\n  Importing Claude Code sessions${all ? " (all projects)" : ""}...\n`);

      const result = await importSessions(client, { all, verbose, dryRun });

      if (dryRun) console.log("  [dry-run] No changes written.\n");
      console.log(`  ${result.imported} sessions imported (${result.totalMessages} messages)`);
      if (result.skippedEmpty > 0) console.log(`  ${result.skippedEmpty} skipped (empty transcript)`);
      if (result.failed > 0) console.log(`  ${result.failed} failed`);
      console.log();
      break;
    }
    default:
      console.error("Usage: lcm <daemon|compact|import|restore|session-end|user-prompt|mcp|install|uninstall|doctor|diagnose|status|stats|connectors|sensitive> [options]");
      exit(1);
  }
}

main().catch((err) => { console.error(err); exit(1); });
