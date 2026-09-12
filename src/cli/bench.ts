import { exit, stdout } from "node:process";
import { resolve } from "node:path";
import { Command } from "commander";
import { parsePositiveInteger } from "./support.js";

export interface BenchCommandDeps {
  admitCliDatabaseWork: () => Promise<void>;
}

export function registerBenchCommands(program: Command, deps: BenchCommandDeps): void {
  const { admitCliDatabaseWork } = deps;

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
      const { buildBench } = await import("../bench.js");
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
      const { runBench } = await import("../bench.js");
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
