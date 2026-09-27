import { exit } from "node:process";
import { join } from "node:path";
import { Command, Option } from "commander";
import { lcmHome } from "../lcm-home.js";
import { createLcmPaths } from "../lcm-paths.js";
import { fail, helpRequested, showHelpAndExit } from "./support.js";
import type { DaemonConfig } from "../daemon/config.js";
import type { DaemonLog } from "../daemon/log.js";

/**
 * Opens the daemon log for this process and records a crash before exiting, so
 * an uncaught exception leaves `daemon.crash` and `daemon.stop` behind.
 */
async function openProcessLog(config: DaemonConfig): Promise<DaemonLog> {
  const { openDaemonLog } = await import("../daemon/log.js");
  const { projectDir } = await import("../daemon/project.js");
  const { PKG_VERSION } = await import("../daemon/version.js");
  const paths = createLcmPaths(lcmHome());
  const log = openDaemonLog({
    path: join(paths.logsDir, "daemon.log"),
    level: config.daemon.logLevel,
    maxSizeMB: config.daemon.logMaxSizeMB,
    retentionDays: config.daemon.logRetentionDays,
    globalPatterns: config.security?.sensitivePatterns ?? [],
    projectDirFor: (cwd) => projectDir(cwd, paths),
    version: PKG_VERSION ?? "unknown",
  });
  process.on("uncaughtException", (err) => {
    // The stack goes into the record, where it is scrubbed; a raw copy on stderr would not be.
    log.write("error", "daemon.crash", { err, stack: err instanceof Error ? err.stack : undefined });
    log.close("crash");
    exit(1);
  });
  return log;
}

export function registerDaemonCommands(program: Command): void {
  // ─── daemon ────────────────────────────────────────────────────────────────
  const daemonCmd = new Command("daemon").description("Start the context daemon");
  daemonCmd.helpOption(false).option("-h, --help", "Show help");
  const daemonPaths = () => {
    const paths = createLcmPaths(lcmHome());
    return { lcDir: paths.home, pidFilePath: paths.pidPath, tokenPath: paths.tokenPath, configPath: paths.configPath };
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
      if (helpRequested(daemonCmd, opts)) await showHelpAndExit("daemon");
      const { ensureDaemon, checkDaemonHealth, describePortHolder, identifyPortHolder, isStaleDaemon, registerDaemonActivity } = await import("../daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { PKG_VERSION, BUILD_ID } = await import("../daemon/version.js");
      const { clearHold, readHold } = await import("../daemon/hold.js");
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
          const holder = identifyPortHolder(port, pidFilePath);
          fail(holder.pid !== undefined
            ? describePortHolder(port, holder, configPath)
            : `lcm daemon did not answer on port ${port} within 10s — check ~/.lossless-claude/logs/daemon.log and ~/.lossless-claude/logs/daemon.stderr`);
        }
        const h = await checkDaemonHealth(port);
        console.log(`lcm daemon started in background on port ${port} (pid ${h?.pid ?? "?"})`);
        return;
      }

      const { createDaemon } = await import("../daemon/server.js");
      const { ensureAuthToken } = await import("../daemon/auth.js");
      const { writeFileSync } = await import("node:fs");
      const log = await openProcessLog(config);
      const unregisterStartup = registerDaemonActivity(pidFilePath);
      try {
        // Register before checking: a concurrent held stop either sees this
        // process or has already published the hold that prevents startup.
        if (readHold(pidFilePath)) { process.exitCode = 75; return; }
        ensureAuthToken(tokenPath);
        const daemon = await createDaemon(config, { tokenPath, backfillIdentities: true, log });
        if (readHold(pidFilePath)) {
          await daemon.stop();
          process.exitCode = 75;
          return;
        }
        log.start();
        const { logUnavailableEndpoints } = await import("../daemon/summarizer.js");
        logUnavailableEndpoints(log, config.llm);
        writeFileSync(pidFilePath, String(process.pid));
        console.log(`lcm daemon started on port ${daemon.address().port}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EADDRINUSE") {
          console.error(describePortHolder(port, identifyPortHolder(port, pidFilePath), configPath));
        } else {
          console.error(`lcm daemon failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
        exit(1);
      } finally {
        unregisterStartup();
      }
      process.on("SIGTERM", () => { log.close("SIGTERM"); exit(0); });
      process.on("SIGINT", () => { log.close("SIGINT"); exit(0); });
    });

  daemonCmd.command("stop")
    .description("Stop the background daemon")
    .option("--hold", "Keep it down until `lcm daemon start`, so session hooks cannot respawn it")
    .option("--minutes <n>", "How long the hold lasts before expiring", (v) => Number(v))
    .option("--reason <text>", "Why the daemon is held down")
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (helpRequested(daemonCmd, opts)) await showHelpAndExit("daemon");
      const { stopDaemon, checkDaemonHealth } = await import("../daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { writeHold, DEFAULT_HOLD_MINUTES } = await import("../daemon/hold.js");
      const { pidFilePath, configPath } = daemonPaths();
      const port = loadDaemonConfig(configPath).daemon?.port ?? 3737;
      if (opts.minutes !== undefined && (!Number.isInteger(opts.minutes) || opts.minutes <= 0)) {
        fail("--minutes must be a positive integer");
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
        fail(`lcm daemon on port ${port} is still up (pid ${pid ?? "?"}) — stop it manually`);
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
      if (helpRequested(daemonCmd, opts)) await showHelpAndExit("daemon");
      const { stopDaemon, ensureDaemon, checkDaemonHealth } = await import("../daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { PKG_VERSION, BUILD_ID } = await import("../daemon/version.js");
      const { clearHold } = await import("../daemon/hold.js");
      const { lcDir, pidFilePath, configPath } = daemonPaths();
      const port = loadDaemonConfig(configPath).daemon?.port ?? 3737;
      // A restart ends with the daemon up, so it releases a hold the same way start does.
      if (clearHold(pidFilePath)) console.log("released the daemon hold");
      const { stopped, pid } = await stopDaemon({ port, pidFilePath });
      if (!stopped) {
        fail(`lcm daemon on port ${port} is still up (pid ${pid ?? "?"}) — stop it manually`);
      }
      const { mkdirSync } = await import("node:fs");
      mkdirSync(lcDir, { recursive: true });
      const { connected } = await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 10000, expectedVersion: PKG_VERSION, expectedBuild: BUILD_ID });
      if (!connected) {
        fail(`lcm daemon did not answer on port ${port} within 10s — check ~/.lossless-claude/logs/daemon.log and ~/.lossless-claude/logs/daemon.stderr`);
      }
      const h = await checkDaemonHealth(port);
      console.log(`lcm daemon restarted on port ${port} (pid ${h?.pid ?? "?"}, v${h?.version ?? "?"})`);
    });

  daemonCmd.action(async (opts) => {
    if (helpRequested(daemonCmd, opts)) await showHelpAndExit("daemon");
  });
  program.addCommand(daemonCmd);
}
