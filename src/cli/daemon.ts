import { exit } from "node:process";
import { join } from "node:path";
import { Command, Option } from "commander";
import { lcmHome } from "../lcm-home.js";
import { fail, helpRequested, showHelpAndExit } from "./support.js";

export function registerDaemonCommands(program: Command): void {
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
      if (helpRequested(daemonCmd, opts)) await showHelpAndExit("daemon");
      const { ensureDaemon, checkDaemonHealth, isStaleDaemon, registerDaemonActivity } = await import("../daemon/lifecycle.js");
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
          fail(`lcm daemon did not answer on port ${port} within 10s — check ~/.lossless-claude/daemon.log`);
        }
        const h = await checkDaemonHealth(port);
        console.log(`lcm daemon started in background on port ${port} (pid ${h?.pid ?? "?"})`);
        return;
      }

      const { createDaemon } = await import("../daemon/server.js");
      const { ensureAuthToken } = await import("../daemon/auth.js");
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
        fail(`lcm daemon did not answer on port ${port} within 10s — check ~/.lossless-claude/daemon.log`);
      }
      const h = await checkDaemonHealth(port);
      console.log(`lcm daemon restarted on port ${port} (pid ${h?.pid ?? "?"}, v${h?.version ?? "?"})`);
    });

  daemonCmd.action(async (opts) => {
    if (helpRequested(daemonCmd, opts)) await showHelpAndExit("daemon");
  });
  program.addCommand(daemonCmd);
}
