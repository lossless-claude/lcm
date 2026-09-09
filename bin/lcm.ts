#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv, exit, stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { DaemonClient } from "../src/daemon/client.js";
import { lcmHome, lcmPath } from "../src/lcm-home.js";

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



export function registerMemoryCommands(program: Command): void {
  program
    .command("search <query>")
    .description("Search memory across episodic and promoted layers")
    .option("--limit <n>", "Max results per layer", "5")
    .option("--layer <name>", "Layer to search: episodic or promoted (repeatable)", collectRepeatedOption, [])
    .option("--tag <tag>", "Require a tag on matching entries (repeatable)", collectRepeatedOption, [])
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("search"); exit(0);
      }

      const layers = normalizeStringList(opts.layer);
      const tags = normalizeStringList(opts.tag) ?? [];
      ensureAllowedValues(layers, ["episodic", "promoted"], "--layer");

      const client = await createDaemonClientOrExit();
      const result = await client.post("/search", {
        cwd: process.cwd(),
        query,
        limit: parsePositiveInteger(String(opts.limit ?? "5"), "--limit"),
        layers,
        tags,
      });
      printJson(result);
    });

  program
    .command("grep <query>")
    .description("Search raw messages and summaries by keyword or regex")
    .option("--mode <mode>", "Search mode: full_text or regex", "full_text")
    .option("--scope <scope>", "Scope: messages, summaries, or both", "both")
    .option("--since <iso>", "Only include matches on or after this ISO timestamp")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("grep"); exit(0);
      }

      const mode = ensureAllowedValue(opts.mode, ["full_text", "regex"], "--mode");
      const scope = ensureAllowedValue(opts.scope, ["messages", "summaries", "both"], "--scope");

      const client = await createDaemonClientOrExit();
      const result = await client.post("/grep", {
        cwd: process.cwd(),
        query,
        mode,
        scope,
        since: typeof opts.since === "string" && opts.since.length > 0 ? opts.since : undefined,
      });
      printJson(result);
    });

  program
    .command("describe <nodeId>")
    .description("Inspect metadata for a summary or stored memory node")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (nodeId: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("describe"); exit(0);
      }

      const client = await createDaemonClientOrExit();
      const result = await client.post("/describe", { cwd: process.cwd(), nodeId });
      printJson(result);
    });

  program
    .command("expand <nodeId>")
    .description("Expand a summary node back into source detail")
    .option("--depth <n>", "Traversal depth", "1")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (nodeId: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("expand"); exit(0);
      }

      const client = await createDaemonClientOrExit();
      const result = await client.post("/expand", {
        cwd: process.cwd(),
        nodeId,
        depth: parsePositiveInteger(String(opts.depth ?? "1"), "--depth"),
      });
      printJson(result);
    });

  program
    .command("store <text>")
    .description("Store a durable memory entry for the current project")
    .option("--tag <tag>", "Attach a tag to the stored memory (repeatable)", collectRepeatedOption, [])
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (text: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("store"); exit(0);
      }

      const client = await createDaemonClientOrExit();
      const result = await client.post("/store", {
        cwd: process.cwd(),
        text,
        tags: normalizeStringList(opts.tag) ?? [],
        metadata: {},
      });
      printJson(result);
    });
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.error(`Invalid ${optionName}: ${value}`);
    exit(1);
  }
  return parsed;
}

function ensureAllowedValues(values: string[] | undefined, allowed: readonly string[], optionName: string): void {
  if (!values) return;
  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length > 0) {
    console.error(`Invalid ${optionName}: ${invalid.join(", ")}`);
    exit(1);
  }
}

function ensureAllowedValue(value: unknown, allowed: readonly string[], optionName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    console.error(`Invalid ${optionName}: ${String(value)}`);
    exit(1);
  }
  return value;
}

function printJson(value: unknown): void {
  stdout.write(JSON.stringify(value, null, 2) + "\n");
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

export function registerBenchCommands(program: Command): void {
  // ─── bench ─────────────────────────────────────────────────────────────────
  const benchCmd = new Command("bench").description(
    "Build and run a natural-language retrieval benchmark from this project's ingested sessions",
  );
  benchCmd.action(() => { benchCmd.outputHelp(); });

  benchCmd
    .command("build")
    .description("Sample ingested sessions and write a local benchmark file")
    .option("--project <path>", "Project directory (default: cwd)")
    .option("--n <count>", "Number of questions to generate", "20")
    .option("--out <file>", "Benchmark file path (default: project memory directory)")
    .option("--generator <mode>", "Question generator: llm or mechanical", "mechanical")
    .option("--seed <n>", "Deterministic sampling seed", "42")
    .option("--language <tag>", "Language to write LLM questions in (BCP 47, e.g. pt-BR); default: detected from the corpus")
    .action(async (opts) => {
      const cwd = typeof opts.project === "string" ? resolve(opts.project) : process.cwd();
      const n = parsePositiveInteger(String(opts.n ?? "20"), "--n");
      const seed = parsePositiveInteger(String(opts.seed ?? "42"), "--seed");
      if (!["llm", "mechanical"].includes(opts.generator)) throw new Error("--generator must be llm or mechanical");
      await admitCliDatabaseWork();
      const { buildBench } = await import("../src/bench.js");
      const result = await buildBench({ cwd, n, seed, out: opts.out, generator: opts.generator, language: opts.language });
      stdout.write(result.stdout);
      exit(result.exitCode);
    });

  benchCmd
    .command("run")
    .description("Run the benchmark against search and a grep baseline")
    .option("--project <path>", "Project directory (default: cwd)")
    .option("--k <n>", "Hit-rate cutoff (default: 5)", "5")
    .option("--bench-file <file>", "Benchmark file path (default: project memory directory)")
    .option("--json", "Output structured JSON")
    .option("--union", "Score against every checkout of this repository, not this project alone")
    .action(async (opts) => {
      const cwd = typeof opts.project === "string" ? resolve(opts.project) : process.cwd();
      const k = parsePositiveInteger(String(opts.k ?? "5"), "--k");
      await admitCliDatabaseWork();
      const { runBench } = await import("../src/bench.js");
      const result = await runBench({
        cwd,
        k,
        benchFile: opts.benchFile,
        json: opts.json ?? false,
        union: opts.union ?? false,
      });
      stdout.write(result.stdout);
      exit(result.exitCode);
    });

  program.addCommand(benchCmd);
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
      if (opts.help) { await withCustomHelp(daemonCmd, "daemon"); return; }
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
      if (opts.help) { await withCustomHelp(daemonCmd, "daemon"); return; }
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
      if (opts.help) { await withCustomHelp(daemonCmd, "daemon"); return; }
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
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("stats"); exit(0);
      }

      if (opts.pool) {
        const jsonFlag: boolean = opts.json ?? false;
        const client = await createDaemonClientOrExit();

        let poolData: any = null;
        try {
          poolData = await client.get("/stats/pool");
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : "could not load pool stats"}`);
          exit(1);
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

  registerMemoryCommands(program);

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
    .option("--global", "Inspect the global agent config in your home directory")
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
    .command("install <agent>")
    .description("Install a connector for an agent")
    .option("--type <type>", "Connector type: rules, mcp, skill, or hooks")
    .option("--global", "Install into the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors install <agent> [--type rules|mcp|skill|hooks] [--global]"); exit(1); }
      const type: any = opts.type;
      const { installConnector } = await import("../src/connectors/installer.js");
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
    .command("remove <agent>")
    .description("Remove a connector for an agent")
    .option("--type <type>", "Connector type: rules, mcp, skill, or hooks")
    .option("--global", "Remove from the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors remove <agent> [--type rules|mcp|skill|hooks] [--global]"); exit(1); }
      const type: any = opts.type;
      const { removeConnector } = await import("../src/connectors/installer.js");
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
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const { AGENTS } = await import("../src/connectors/registry.js");
      const { listConnectors, diagnoseConnector } = await import("../src/connectors/installer.js");
      const { findAgent } = await import("../src/connectors/registry.js");
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

  registerBenchCommands(program);

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
