#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv, exit, stdin, stdout } from "node:process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { DaemonClient } from "../src/daemon/client.js";
import { lcmHome, lcmPath } from "../src/lcm-home.js";
import { registerMemoryCommands } from "../src/cli/memory.js";
import { registerBenchCommands } from "../src/cli/bench.js";
import { registerConnectorsCommands } from "../src/cli/connectors.js";
import { registerDiagnosticsCommands, registerDiagnoseCommand } from "../src/cli/diagnostics.js";
import { helpRequested } from "../src/cli/support.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; stdin.destroy(); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }, 5000);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); }
    });
  });
}

export { helpRequested } from "../src/cli/support.js";

async function withCustomHelp(cmd: Command, commandName: string): Promise<void> {
  const { printHelp } = await import("../src/cli-help.js");
  printHelp(commandName);
  exit(0);
}

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

  // ─── daemon ────────────────────────────────────────────────────────────────
  const daemonCmd = new Command("daemon").description("Start the context daemon");
  daemonCmd.helpOption(false).option("-h, --help", "Show help");
  const daemonPaths = () => {
    const lcDir = lcmHome();
    return { lcDir, pidFilePath: join(lcDir, "daemon.pid"), tokenPath: join(lcDir, "daemon.token"), configPath: join(lcDir, "config.json") };
  };
  const describeRunning = (port: number, h: { pid?: number; version?: string; uptime?: number }) =>
    `lcm daemon already running on port ${port}` +
    ` (pid ${h.pid ?? "?"}, v${h.version ?? "?"}, up ${h.uptime ?? 0}s)`;

  daemonCmd.command("start")
    .description("Start the context daemon")
    .option("--detach", "Run in the background")
    .addOption(new Option("--automatic").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (helpRequested(daemonCmd, opts)) { await withCustomHelp(daemonCmd, "daemon"); return; }
      const { ensureDaemon, checkDaemonHealth, isStaleDaemon, registerDaemonActivity } = await import("../src/daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { PKG_VERSION, BUILD_ID } = await import("../src/daemon/version.js");
      const { clearHold, readHold } = await import("../src/daemon/hold.js");
      const { lcDir, pidFilePath, tokenPath, configPath } = daemonPaths();
      const config = loadDaemonConfig(configPath);
      const port = config.daemon?.port ?? 3737;

      // Automatic starts report an active hold with EX_TEMPFAIL (75), without consuming hook cooldown.
      // Starting is the release gesture: an explicit start always wins over a hold.
      if (opts.automatic) {
        if (readHold(pidFilePath)) { process.exitCode = 75; return; }
      } else if (clearHold(pidFilePath)) console.log("released the daemon hold");

      const running = await checkDaemonHealth(port);
      if (running?.status === "ok") {
        console.log(describeRunning(port, running));
        if (running.pid) {
          // Heal a PID file that drifted from the daemon that actually answers
          const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
          let recorded: string | undefined;
          try { recorded = readFileSync(pidFilePath, "utf-8").trim(); } catch { /* missing */ }
          if (recorded !== String(running.pid)) {
            mkdirSync(lcDir, { recursive: true });
            writeFileSync(pidFilePath, String(running.pid));
          }
        }
        if (isStaleDaemon(running, { version: PKG_VERSION, build: BUILD_ID })) {
          console.log("  Running build differs from the installed one. Restart with: lcm daemon restart");
        }
        return;
      }

      if (opts.detach) {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(lcDir, { recursive: true });
        const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 10000 });
        if (!connected) {
          if (opts.automatic && readHold(pidFilePath)) { process.exitCode = 75; return; }
          console.error(`lcm daemon did not answer on port ${port} within 10s — check ~/.lossless-claude/daemon.log`);
          exit(1);
        }
        const h = await checkDaemonHealth(port);
        console.log(`lcm daemon started in background on port ${port} (pid ${h?.pid ?? "?"})`);
        return;
      }

      const { createDaemon } = await import("../src/daemon/server.js");
      const { ensureAuthToken } = await import("../src/daemon/auth.js");
      const { writeFileSync } = await import("node:fs");
      const unregisterStartup = registerDaemonActivity(pidFilePath);
      try {
        // Register before checking: a concurrent held stop either sees this
        // process or has already published the hold that prevents startup.
        if (readHold(pidFilePath)) { process.exitCode = 75; return; }
        ensureAuthToken(tokenPath);
        const daemon = await createDaemon(config, { tokenPath, backfillIdentities: true });
        if (readHold(pidFilePath)) {
          await daemon.stop();
          process.exitCode = 75;
          return;
        }
        writeFileSync(pidFilePath, String(process.pid));
        console.log(`lcm daemon started on port ${daemon.address().port}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EADDRINUSE") {
          console.error(`Port ${port} is already in use by another process (not an lcm daemon). Stop it or change daemon.port in ${configPath}.`);
        } else {
          console.error(`lcm daemon failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
        exit(1);
      } finally {
        unregisterStartup();
      }
      process.on("SIGTERM", () => exit(0));
      process.on("SIGINT", () => exit(0));
    });

  daemonCmd.command("stop")
    .description("Stop the background daemon")
    .option("--hold", "Keep it down until `lcm daemon start`, so session hooks cannot respawn it")
    .option("--minutes <n>", "How long the hold lasts before expiring", (v) => Number(v))
    .option("--reason <text>", "Why the daemon is held down")
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (helpRequested(daemonCmd, opts)) { await withCustomHelp(daemonCmd, "daemon"); return; }
      const { stopDaemon, checkDaemonHealth } = await import("../src/daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { writeHold, DEFAULT_HOLD_MINUTES } = await import("../src/daemon/hold.js");
      const { pidFilePath, configPath } = daemonPaths();
      const port = loadDaemonConfig(configPath).daemon?.port ?? 3737;
      if (opts.minutes !== undefined && (!Number.isInteger(opts.minutes) || opts.minutes <= 0)) {
        console.error("--minutes must be a positive integer");
        exit(1);
      }
      const before = await checkDaemonHealth(port);
      // The hold goes down first: between the kill and the marker, a hook that
      // fires would spawn the daemon straight back.
      let held: { until: string } | undefined;
      if (opts.hold) {
        held = writeHold(pidFilePath, { minutes: opts.minutes, reason: opts.reason });
      }
      const { stopped, pid } = await stopDaemon({ port, pidFilePath });
      if (!stopped) {
        console.error(`lcm daemon on port ${port} is still up (pid ${pid ?? "?"}) — stop it manually`);
        exit(1);
      }
      console.log(before ? `lcm daemon stopped (pid ${pid ?? before.pid ?? "?"})` : "lcm daemon was not running");
      if (held) {
        console.log(`  held down until ${held.until} (${opts.minutes ?? DEFAULT_HOLD_MINUTES} min) — release with: lcm daemon start`);
      }
    });

  daemonCmd.command("restart")
    .description("Restart the background daemon")
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (helpRequested(daemonCmd, opts)) { await withCustomHelp(daemonCmd, "daemon"); return; }
      const { stopDaemon, ensureDaemon, checkDaemonHealth } = await import("../src/daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { PKG_VERSION, BUILD_ID } = await import("../src/daemon/version.js");
      const { clearHold } = await import("../src/daemon/hold.js");
      const { lcDir, pidFilePath, configPath } = daemonPaths();
      const port = loadDaemonConfig(configPath).daemon?.port ?? 3737;
      // A restart ends with the daemon up, so it releases a hold the same way start does.
      if (clearHold(pidFilePath)) console.log("released the daemon hold");
      const { stopped, pid } = await stopDaemon({ port, pidFilePath });
      if (!stopped) {
        console.error(`lcm daemon on port ${port} is still up (pid ${pid ?? "?"}) — stop it manually`);
        exit(1);
      }
      const { mkdirSync } = await import("node:fs");
      mkdirSync(lcDir, { recursive: true });
      const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 10000, expectedVersion: PKG_VERSION, expectedBuild: BUILD_ID });
      if (!connected) {
        console.error(`lcm daemon did not answer on port ${port} within 10s — check ~/.lossless-claude/daemon.log`);
        exit(1);
      }
      const h = await checkDaemonHealth(port);
      console.log(`lcm daemon restarted on port ${port} (pid ${h?.pid ?? "?"}, v${h?.version ?? "?"})`);
    });

  daemonCmd.action(async (opts) => {
    if (helpRequested(daemonCmd, opts)) { await withCustomHelp(daemonCmd, "daemon"); return; }
  });
  program.addCommand(daemonCmd);

  // ─── compact ───────────────────────────────────────────────────────────────
  program
    .command("compact")
    .description("Compact conversation context into DAG summary nodes")
    .option("--all", "Compact all tracked projects")
    .option("--dry-run", "Show what would be compacted without writing")
    .option("--replay", "Compact sequentially with threaded context")
    .option("--restart", "Discard recorded replay progress and start from scratch")
    .option("--no-promote", "Skip the automatic promote step")
    .option("-v, --verbose", "Show per-session token details")
    .addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp())
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("compact"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const replay: boolean = opts.replay ?? false;
      const restart: boolean = opts.restart ?? false;
      // Hook dispatch only when --hook is explicit; all other invocations go to batch.
      const hook: boolean = opts.hook ?? false;
      if (!hook) {
        const { batchCompact } = await import("../src/batch-compact.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const config = loadDaemonConfig(lcmPath("config.json"));
        const port = config.daemon?.port ?? 3737;
        const client = await createDaemonClientOrExit(10000);
        const noPromote: boolean = !opts.promote;
        const minTokens = config.compaction.autoCompactMinTokens;
        const cwd = all ? undefined : process.cwd();
        const tokenPath = lcmPath("daemon.token");

        const { NinjaRenderer } = await import("../src/cli/pipeline-runner.js");
        const { makeProgressState } = await import("../src/cli/progress-state.js");
        const isTTY = process.stdout.isTTY ?? false;
        const renderOpts = { isTTY, width: process.stdout.columns ?? 80, color: isTTY, verbose };
        const compactState = makeProgressState({ phases: [{ name: "Compact", status: "active" }], dryRun });
        const compactRenderer = new NinjaRenderer({ state: compactState, renderOpts });
        compactRenderer.start();

        const replayModel = config.llm.model || undefined;
        const { compacted } = await batchCompact({
          minTokens, dryRun, port, cwd, replay, restart, verbose, tokenPath,
          replayModel,
          onBeforeSession: () => !compactRenderer.shouldStop,
          trackInFlight: () => compactRenderer.trackInFlight(),
          onProgress: (patch) => {
            if (patch.resumed) {
              const model = patch.resumed.model ? `, ${patch.resumed.model}` : "";
              console.log(`  resuming: ${patch.resumed.doneCount}/${patch.resumed.totalCount} done, ${patch.resumed.totalCount - patch.resumed.doneCount} remaining${model}`);
            }
            Object.assign(compactState, patch);
            if (patch.lastResult) compactRenderer.sessionDone();
          },
        });

        compactRenderer.stop();
        if (isTTY) {
          compactState.phases[0].status = "done";
          compactRenderer.printSummary();
        }

        // Auto-promote after a successful compact: new summaries are prime promotion candidates.
        if (compacted > 0 && !noPromote) {
          const { readdirSync, existsSync, readFileSync } = await import("node:fs");
          const promoteCwds: string[] = [];
          if (cwd) {
            promoteCwds.push(cwd);
          } else {
            const projectsDir = lcmPath("projects");
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
              const result = await client.post<{ processed: number; promoted: number }>("/promote", {
                cwd: promoteCwd,
                dry_run: dryRun,
              });
              totalPromoted += result.promoted;
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

  program
    .command("codex-hook")
    .description("Dispatch a native Codex lifecycle hook")
    .action(async () => {
      const { dispatchCodexHook } = await import("../src/hooks/codex.js");
      const result = await dispatchCodexHook(await readStdin());
      if (result.stdout) stdout.write(result.stdout + "\n");
      exit(result.exitCode);
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

  // ─── post-tool (hook) ──────────────────────────────────────────────────────
  program
    .command("post-tool")
    .description("Dispatch the post-tool hook (PostToolUse event)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("post-tool"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("post-tool", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-snapshot (hook) ─────────────────────────────────────────────
  program
    .command("session-snapshot")
    .description("Rolling ingest snapshot (called by Stop hook)")
    .helpOption(false)
    .action(async () => {
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("session-snapshot", input);
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

  // ─── import ────────────────────────────────────────────────────────────────
  program
    .command("import")
    .description("Import Claude Code or Codex session transcripts into lossless memory")
    .option("--provider <provider>", "Transcript source: claude, codex, all (replay defaults to all)")
    .option("--codex", "Import Codex transcripts (alias for --provider codex)")
    .option("--all", "Import all projects")
    .option("--verbose", "Show per-session import detail")
    .option("--dry-run", "Preview without importing")
    .option("--replay", "Replay compaction for each imported session")
    .option("--restart", "Discard recorded replay progress and start from scratch")
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
      const restart: boolean = opts.restart ?? false;

      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { NinjaRenderer } = await import("../src/cli/pipeline-runner.js");
      const { makeProgressState } = await import("../src/cli/progress-state.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { importSessions } = await import("../src/import.js");
      type ImportProvider = import("../src/import.js").ImportProvider;

      let provider: ImportProvider = opts.codex ? "codex" : replay ? "all" : "claude";
      if (opts.codex && opts.provider && opts.provider !== "codex") {
        console.error("  --codex cannot be combined with a different --provider");
        exit(1);
      }
      if (opts.provider) {
        const provVal = opts.provider as string;
        if (provVal === "claude" || provVal === "codex" || provVal === "all") {
          provider = provVal as ImportProvider;
        } else {
          console.error(`  Unknown provider "${provVal}". Use: claude, codex, all`);
          exit(1);
        }
      }

      const config = loadDaemonConfig(lcmPath("config.json"));
      const port = config.daemon?.port ?? 3737;
      const previewClient = new DaemonClient(`http://127.0.0.1:${port}`);
      const preview = await importSessions(previewClient, { all, provider, dryRun: true, verbose: dryRun && verbose, replay });
      if (dryRun) {
        console.log(`  [dry-run] ${preview.imported} ${provider} sessions selected (${all ? "all projects" : "current project"})${replay ? "; would compact each session" : ""}. No changes written.`);
        return;
      }
      const client = await createDaemonClientOrExit();

      const isTTY = process.stdout.isTTY ?? false;
      const renderOpts = { isTTY, width: process.stdout.columns ?? 80, color: isTTY, verbose };
      const state = makeProgressState({
        phases: [{ name: "Import", status: "active" }],
        total: preview.imported,
        dryRun,
      });
      const renderer = new NinjaRenderer({ state, renderOpts });

      const providerLabel =
        provider === "codex" ? "Codex CLI" :
        provider === "all"   ? "Claude Code + Codex CLI" :
                               "Claude Code";
      console.log(`\n  Importing ${providerLabel} sessions${all ? " (all projects)" : ""}...\n`);
      renderer.start();

      const result = await importSessions(client, {
        all, verbose, dryRun, replay, restart, provider,
        replayModel: config.llm.model || undefined,
        onBeforeSession: () => !renderer.shouldStop,
        trackInFlight: () => renderer.trackInFlight(),
        onProgress: (patch) => {
          if (patch.resumed) {
            const model = patch.resumed.model ? `, ${patch.resumed.model}` : "";
            console.log(`  resuming: ${patch.resumed.doneCount}/${patch.resumed.totalCount} done, ${patch.resumed.totalCount - patch.resumed.doneCount} remaining${model}`);
          }
          Object.assign(state, patch);
          if (patch.lastResult) renderer.sessionDone();
        },
      });

      renderer.stop();

      if (isTTY && !verbose) {
        state.phases[0].status = "done";
        renderer.printSummary();
      } else {
        const { printImportSummary } = await import("../src/import-summary.js");
        if (dryRun) console.log("  [dry-run] No changes written.\n");
        printImportSummary(result, { replay });
        console.log();
      }
    });

  registerBenchCommands(program, { admitCliDatabaseWork });

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

      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const config = loadDaemonConfig(lcmPath("config.json"));
      const port = config.daemon?.port ?? 3737;
      const client = await createDaemonClientOrExit();
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");

      if (dryRun) console.log("  [dry-run] No changes will be written.\n");

      // Collect project cwds to promote
      const cwds: string[] = [];
      if (all) {
        const projectsDir = lcmPath("projects");
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

        try {
          const result = await client.post<{ processed: number; promoted: number; conversations?: number }>("/promote", {
            cwd,
            dry_run: dryRun,
          });

          totalProcessed += result.processed;
          totalPromoted += result.promoted;

          if (verbose) {
            process.stdout.write("\r");
            const convLabel = result.conversations !== undefined ? `, ${result.conversations} conversation${result.conversations !== 1 ? "s" : ""}` : "";
            console.log(`  ${cwd}: ${result.processed} scanned${convLabel}, ${result.promoted} promoted`);
          }
        } catch (err) {
          if (verbose) console.error(`  promote failed for ${cwd}: ${err instanceof Error ? err.message : "request failed"}`);
          continue;
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
    });

  // ─── export ────────────────────────────────────────────────────────────────
  program
    .command("export")
    .description("Export promoted knowledge to a portable JSON file")
    .option("--all", "Export all projects (one JSON per project, written to files)")
    .option("--tags <tags>", "Only export entries matching these comma-separated tags")
    .option("--since <date>", "Only export entries created on or after this ISO date (e.g. 2026-01-01)")
    .option("--output <file>", "Write output to file instead of stdout")
    .option("--format <format>", "Output format: json (default)", "json")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("export"); exit(0);
      }

      await admitCliDatabaseWork();
      const { exportKnowledge } = await import("../src/portable-knowledge.js");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const { existsSync, readdirSync, readFileSync } = await import("node:fs");

      const tags: string[] | undefined = opts.tags
        ? (opts.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean)
        : undefined;
      const since: string | undefined = opts.since;
      const output: string | undefined = opts.output;
      const all: boolean = opts.all ?? false;

      const cwds: string[] = [];
      if (all) {
        const projectsDir = lcmPath("projects");
        if (existsSync(projectsDir)) {
          for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = join(projectsDir, entry.name, "meta.json");
            if (!existsSync(metaPath)) continue;
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta.cwd) cwds.push(meta.cwd);
            } catch { /* skip */ }
          }
        }
      } else {
        cwds.push(process.cwd());
      }

      let total = 0;
      for (const cwd of cwds) {
        let outFile: string | undefined = output;
        if (all && output === undefined) {
          // When --all and no --output, generate filenames automatically
          const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(-40);
          outFile = join(process.cwd(), `lcm-export-${slug}.json`);
        }
        try {
          const result = await exportKnowledge(cwd, { tags, since, output: outFile });
          total += result.exported;
          if (all) {
            console.log(`  ${cwd}: ${result.exported} entries → ${outFile}`);
          } else if (outFile) {
            console.log(`  Exported ${result.exported} entries to ${outFile}`);
          }
        } catch (err: any) {
          process.stderr.write(`  Warning: ${err.message}\n`);
        }
      }

      if (all) console.log(`\n  Total: ${total} entries exported`);
    });

  // ─── import-knowledge ──────────────────────────────────────────────────────
  program
    .command("import-knowledge <file>")
    .description("Import exported knowledge JSON into lossless memory")
    .option("--merge", "Merge with existing entries, deduplicating (default)")
    .option("--dry-run", "Preview import without writing anything")
    .option("--confidence <n>", "Override confidence for all imported entries (0.0–1.0)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (file: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import-knowledge"); exit(0);
      }

      await admitCliDatabaseWork();
      const { importKnowledge } = await import("../src/portable-knowledge.js");
      const { readFileSync } = await import("node:fs");

      const dryRun: boolean = opts.dryRun ?? false;
      const confidence: number | undefined = opts.confidence !== undefined
        ? parseFloat(opts.confidence as string)
        : undefined;

      if (confidence !== undefined && (isNaN(confidence) || confidence < 0 || confidence > 1)) {
        console.error("  --confidence must be a number between 0.0 and 1.0");
        exit(1);
      }

      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch (err: any) {
        console.error(`  Cannot read file: ${err.message}`);
        exit(1);
      }

      let doc: any;
      try {
        doc = JSON.parse(raw);
      } catch {
        console.error("  Invalid JSON in export file");
        exit(1);
      }

      if (!doc || typeof doc.version !== "number" || !Array.isArray(doc.entries)) {
        console.error("  File does not look like an lcm export (missing version or entries)");
        exit(1);
      }

      const cwd = process.cwd();

      if (dryRun) {
        console.log(`\n  [dry-run] Would import ${doc.entries.length} entries into ${cwd}`);
        console.log("  No changes written.\n");
        exit(0);
      }

      try {
        const result = await importKnowledge(cwd, doc, { merge: true, dryRun, confidence });
        if (result.dryRun) {
          console.log(`\n  [dry-run] Would import ${result.total} entries. No changes written.\n`);
        } else {
          console.log(`\n  Imported ${result.imported} entries (${result.skipped} skipped) into ${cwd}\n`);
        }
      } catch (err: any) {
        console.error(`  Import failed: ${err.message}`);
        exit(1);
      }
    });

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
