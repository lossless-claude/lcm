import { exit, stdout } from "node:process";
import { Option } from "commander";
import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import { lcmPath } from "../lcm-home.js";
import { readStdin } from "./support.js";

export interface CompactCommandDeps {
  createDaemonClientOrExit: (spawnTimeoutMs?: number) => Promise<DaemonClient>;
}

export function registerCompactCommand(program: Command, deps: CompactCommandDeps): void {
  const { createDaemonClientOrExit } = deps;

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
        const { printHelp } = await import("../cli-help.js");
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
        const { batchCompact } = await import("../batch-compact.js");
        const { loadDaemonConfig } = await import("../daemon/config.js");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const config = loadDaemonConfig(lcmPath("config.json"));
        const port = config.daemon?.port ?? 3737;
        const client = await createDaemonClientOrExit(10000);
        const noPromote: boolean = !opts.promote;
        const minTokens = config.compaction.autoCompactMinTokens;
        const cwd = all ? undefined : process.cwd();
        const tokenPath = lcmPath("daemon.token");

        const { NinjaRenderer } = await import("./pipeline-runner.js");
        const { makeProgressState } = await import("./progress-state.js");
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
      const { dispatchHook } = await import("../hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("compact", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });
}
