import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateCompactionShadow } from "../dist/src/eval/compaction-shadow/index.js";
import { createLcmPaths } from "../dist/src/lcm-paths.js";

const allowed = new Set(["--home", "--output", "--transcripts", "--seed", "--limit", "--rates"]);
try {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) throw new Error("Provide unique --home, --output and optional --transcripts, --seed, --limit, --rates values.");
    values.set(key, value);
  }
  if (!values.has("--home") || !values.has("--output")) throw new Error("--home and --output are required");
  const rates = values.get("--rates");
  const report = await evaluateCompactionShadow({ paths: createLcmPaths(resolve(values.get("--home")!)), output: resolve(values.get("--output")!), seed: values.get("--seed"),
    limit: values.has("--limit") ? Number(values.get("--limit")) : undefined, transcriptManifest: values.get("--transcripts"), rates: rates ? JSON.parse(readFileSync(rates, "utf8")) : undefined });
  process.stdout.write(`Phase 1: ${report.sampleAdequacy.cuts} cuts, ${report.sampleAdequacy.projects} projects; continuation scoring not run.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Evaluation failed"}\n`); process.exitCode = 1;
}
