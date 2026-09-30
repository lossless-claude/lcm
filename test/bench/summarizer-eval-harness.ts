import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CorpusSession, CorpusMessage, EvalRunResult } from "../../src/eval/engine.js";
export * from "../../src/eval/engine.js";

/** Load every `<label>.json` in a directory; each file is a `CorpusMessage[]`. */
export function loadCorpusDir(dir: string): CorpusSession[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      label: basename(f, ".json"),
      messages: JSON.parse(readFileSync(join(dir, f), "utf-8")) as CorpusMessage[],
    }));
}

export function writeResult(dir: string, result: EvalRunResult): string {
  mkdirSync(dir, { recursive: true });
  const safe = (v: string) => v.replace(/[^a-z0-9.-]+/gi, "_");
  // Provider, variant, and language are part of the run's identity: each changes
  // the model request, so omitting one would let unlike runs overwrite each other.
  const variant = result.variant ? `__${safe(result.variant)}` : "";
  const language = result.language ? `__lang-${safe(result.language)}` : "";
  const file = join(dir, `${safe(result.model)}__${safe(result.provider)}${variant}${language}__${result.label}__run${result.run}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}
