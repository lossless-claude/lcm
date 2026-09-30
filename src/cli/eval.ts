import { resolve } from "node:path";
import { Command } from "commander";
import type { LcmPaths } from "../lcm-paths.js";
import { parsePositiveInteger } from "./support.js";

export function registerEvalCommands(program: Command, paths: LcmPaths): void {
  const evalCommand = new Command("eval").description("Measure summarizer candidates on a stored session");
  evalCommand.action(async () => {
    const { printHelp } = await import("../cli-help.js");
    printHelp("eval");
  });
  evalCommand.command("summarizer")
    .description("Compare named endpoints using in-memory production compaction")
    .requiredOption("--session <id>", "Stored session id in this project")
    .requiredOption("--models <endpoints>", "Comma-separated names from llm.providers")
    .option("--project <path>", "Project directory (default: cwd)")
    .option("--runs <n>", "Repeats per session and endpoint", "1")
    .option("--out <dir>", "Local report directory", "summarizer-report")
    .option("--no-planted", "Omit the synthetic planted-facts session")
    .action(async (opts) => {
      const { runSummarizerComparison } = await import("../eval/compare.js");
      const result = await runSummarizerComparison({
        cwd: resolve(opts.project ?? process.cwd()), paths,
        sessionId: opts.session, models: opts.models.split(",").map((name: string) => name.trim()).filter(Boolean),
        runs: parsePositiveInteger(opts.runs, "--runs"), out: opts.out, planted: opts.planted,
      });
      process.stdout.write(`Reports contain conversation content already scrubbed at capture. Keep them local.\nJSON: ${result.jsonPath}\nHTML: ${result.htmlPath}\n`);
      if (result.report.results.some((run) => run.incomplete)) {
        process.stderr.write("One or more candidates failed; partial results are included in the report.\n");
        process.exitCode = 1;
      }
    });
  program.addCommand(evalCommand);
}
