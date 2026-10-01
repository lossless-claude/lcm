import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import type { SettleReport } from "../project-timeline.js";
import { helpRequested, showHelpAndExit } from "./support.js";

export function registerTimelineCommands(program: Command, deps: { createDaemonClientOrExit: () => Promise<DaemonClient> }): void {
  const timeline = program.command("timeline").description("Maintain the project timeline")
    .helpOption(false).option("-h, --help", "Show help").action(() => showHelpAndExit("timeline"));
  for (const action of ["enable", "disable", "teardown"]) timeline.command(action)
    .description(action === "enable" ? "Enable tracking and bootstrap the timeline" : action === "disable" ? "Disable generation while retaining tracking" : "Remove timeline references and tracking triggers")
    .helpOption(false).option("-h, --help", "Show help")
    .action(async opts => {
      if (helpRequested(timeline, opts)) await showHelpAndExit("timeline");
      const client = await deps.createDaemonClientOrExit();
      const report = await client.post<SettleReport>("/timeline", { cwd: process.cwd(), action, calls: 0 });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    });
  timeline.command("settle").description("Reconcile and generate pending timeline nodes")
    .option("--calls <n>", "Maximum summarizer calls (zero reconciles without generation)", "10")
    .option("--reconcile <mode>", "Reconciliation mode: journal or full")
    .helpOption(false).option("-h, --help", "Show help")
    .action(async opts => {
      if (helpRequested(timeline, opts)) await showHelpAndExit("timeline");
      const calls = Number(opts.calls);
      if (!Number.isInteger(calls) || calls < 0) throw new Error("--calls must be a non-negative integer");
      if (opts.reconcile !== undefined && !["journal", "full"].includes(opts.reconcile)) throw new Error("--reconcile must be journal or full");
      const client = await deps.createDaemonClientOrExit();
      let report: SettleReport;
      try {
        report = await client.post<SettleReport>("/timeline", { cwd: process.cwd(), calls, ...(opts.reconcile ? { reconcile: opts.reconcile } : {}) });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (!(error instanceof Error) || status === undefined || status < 400 || status >= 500) throw error;
        process.stderr.write(error.message + "\n");
        process.exitCode = 1;
        return;
      }
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      if (report.stopped === "model-error" || report.stopped === "conflict") process.exitCode = 1;
    });
}
