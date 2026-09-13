import { exit, stdout } from "node:process";
import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import { lcmPath } from "../lcm-home.js";
import { fail, showHelpAndExit } from "./support.js";

export interface DiagnosticsCommandDeps {
  createDaemonClientOrExit: (spawnTimeoutMs?: number) => Promise<DaemonClient>;
}

export function registerDiagnosticsCommands(program: Command, deps: DiagnosticsCommandDeps): void {
  const { createDaemonClientOrExit } = deps;

  // ─── status ────────────────────────────────────────────────────────────────
  program
    .command("status")
    .description("Show daemon status and project memory statistics")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) await showHelpAndExit("status");
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(lcmPath("config.json"));
      const jsonFlag: boolean = opts.json ?? false;
      const client = await createDaemonClientOrExit();

      let daemonStatus = "down";
      let statusData: any = null;

      try {
        const health = await client.health();
        if (health) daemonStatus = "up";

        // Also fetch /status endpoint if daemon is up
        if (daemonStatus === "up") {
          statusData = await client.post("/status", { cwd: process.cwd() });
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
    .option("--pool", "Show connection pool statistics from the daemon")
    .option("--json", "Output structured JSON (use with --pool)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) await showHelpAndExit("stats");

      if (opts.pool) {
        const jsonFlag: boolean = opts.json ?? false;
        const client = await createDaemonClientOrExit();

        let poolData: any = null;
        try {
          poolData = await client.get("/stats/pool");
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : "could not load pool stats"}`);
        }

        if (jsonFlag) {
          stdout.write(JSON.stringify(poolData, null, 2) + "\n");
        } else {
          const dim = "\x1b[2m";
          const cyan = "\x1b[36m";
          const bold = "\x1b[1m";
          const reset = "\x1b[0m";
          console.log();
          console.log(`    ${bold}${cyan}🔌 Connection Pool${reset}`);
          console.log();
          const rows: [string, string][] = [
            ["Total", String(poolData.totalConnections)],
            ["Active", String(poolData.activeConnections)],
            ["Idle", String(poolData.idleConnections)],
          ];
          const labelWidth = Math.max(...rows.map(([l]) => l.length));
          for (const [label, value] of rows) {
            console.log(`    ${dim}${label.padEnd(labelWidth)}${reset}  ${value}`);
          }
          if (poolData.connections && poolData.connections.length > 0) {
            console.log();
            console.log(`    ${dim}Connections:${reset}`);
            for (const conn of poolData.connections) {
              const status = conn.status === "active" ? `${cyan}active${reset}` : `${dim}idle${reset}`;
              console.log(`    ${dim}refs=${conn.refs}${reset}  ${status}  ${conn.path}`);
            }
          }
          console.log();
        }
        return;
      }

      const verbose: boolean = opts.verbose ?? false;
      const { collectStats, printStats } = await import("../stats.js");
      printStats(collectStats(), verbose);
    });

  // ─── doctor ────────────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Run diagnostics: daemon, hooks, MCP, summarizer")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) await showHelpAndExit("doctor");
      const { runDoctor, printResults } = await import("../doctor/doctor.js");
      const results = await runDoctor();
      printResults(results);
      const failures = results.filter((r: { status: string }) => r.status === "fail");
      exit(failures.length > 0 ? 1 : 0);
    });
}

export function registerDiagnoseCommand(program: Command): void {
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
      if (opts.help) await showHelpAndExit("diagnose");
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const json: boolean = opts.json ?? false;
      const days = Number(opts.days);

      if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
        fail("Usage: lcm diagnose [--all] [--days N] [--verbose] [--json]");
      }

      const { diagnose, formatDiagnoseResult } = await import("../diagnose.js");
      const result = await diagnose({ all, days, verbose });

      if (json) {
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        stdout.write(formatDiagnoseResult(result, { days, verbose }));
      }
    });
}
