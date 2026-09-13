import { stdout } from "node:process";
import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import { fail, parsePositiveInteger, showHelpAndExit } from "./support.js";

export interface MemoryCommandDeps {
  createDaemonClientOrExit: (spawnTimeoutMs?: number) => Promise<DaemonClient>;
}

export function registerMemoryCommands(program: Command, deps: MemoryCommandDeps): void {
  const { createDaemonClientOrExit } = deps;

  program
    .command("search <query>")
    .description("Search memory across episodic and promoted layers")
    .option("--limit <n>", "Max results per layer", "5")
    .option("--layer <name>", "Layer to search: episodic or promoted (repeatable)", collectRepeatedOption, [])
    .option("--tag <tag>", "Require a tag on matching entries (repeatable)", collectRepeatedOption, [])
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      if (opts.help) await showHelpAndExit("search");

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
      if (opts.help) await showHelpAndExit("grep");

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
      if (opts.help) await showHelpAndExit("describe");

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
      if (opts.help) await showHelpAndExit("expand");

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
      if (opts.help) await showHelpAndExit("store");

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

function ensureAllowedValues(values: string[] | undefined, allowed: readonly string[], optionName: string): void {
  if (!values) return;
  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length > 0) {
    fail(`Invalid ${optionName}: ${invalid.join(", ")}`);
  }
}

function ensureAllowedValue(value: unknown, allowed: readonly string[], optionName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(`Invalid ${optionName}: ${String(value)}`);
  }
  return value;
}

function printJson(value: unknown): void {
  stdout.write(JSON.stringify(value, null, 2) + "\n");
}
