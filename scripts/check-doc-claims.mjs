#!/usr/bin/env node
// Checks that what the tracked Markdown tells a reader to type exists in the code.
//
// Three claim types, each exact and cheap:
//   (a) `lcm <subcommand...> --flag` inside a code span or fenced block, checked against the
//       full command path (e.g. `lcm daemon start`, `lcm connectors install`) built from
//       bin/lcm.ts and src/cli-help.ts — a flag valid on one path is not assumed valid on
//       another;
//   (b) an `LCM_*` environment variable, against every LCM_* token the code, scripts,
//       tests and workflows read;
//   (c) an `lcm_*` MCP tool name, against src/mcp/tools/*.ts.
//
// A claim the code does not back is an error and fails the run. The reverse direction — a
// CLI option or public env var the code defines that no document mentions — is a warning,
// because whether a knob is public is a judgement this script cannot make. CLI warnings are
// reported per command path (`lcm compact --restart`), since the same flag name can be
// legitimate on one path and unknown on another.
//
// INTERNAL_ENV lists LCM_* variables read only by tests, scripts or CI — deliberately
// undocumented — so they do not produce the "no document mentions it" warning. This is
// enforced, not just curated: a variable INTERNAL_ENV lists but production code (src/, bin/,
// hooks/, installer/) also reads stays a warning candidate regardless.
//
// Coverage comes from `git ls-files`, never from a list written by hand. Excluded on
// purpose: CHANGELOG.md and .changeset/ (records of the past), docs/design/ (proposals),
// plans/ (untracked working notes), bundle/ (a build artifact: copies of the templates).
//
// Both sides abort when empty: an empty code side would pass every claim, which is the
// exact failure this script exists to catch.
//
// CLI extraction (bin/lcm.ts, plus every src/cli/*.ts): a small bracket-depth scanner reads
// the exact statement that follows each recognised chain root — `new Command("name")`,
// `<ident>.command("name")`, or a bare `<ident>.option(...)` / `.addOption(...)` /
// `.requiredOption(...)` not part of a `.command()` chain — so options are attributed to the
// command path they were actually declared on, not to every `lcm` invocation on the line. An
// identifier that receives `.command(...)` but was never declared with `new Command(...)` in
// that file (e.g. a `register<Group>Commands(program)` function whose `program` is a
// parameter, not a local `new Command()`) is treated as the root — empty path — so commands
// registered from a file split out of bin/lcm.ts still attach to the right path. Each command
// source file is parsed independently and the per-file surfaces (command paths, their
// options, global flags) are merged by path before `src/cli-help.ts` is read.
// `src/cli-help.ts` is hand-written help for hand-parsed subcommands (e.g. `sensitive purge
// --yes`, which Commander never sees as its own command): an option line there whose text
// starts with a bare word before its `[--flags]` attaches those flags to `lcm <section>
// <word>`; a line starting directly with a flag attaches to the bare `lcm <section>`, but
// only when the merged command surface gives that section no subcommands of its own — a
// group command's (`daemon`, `connectors`) flattened help list is for the reader, not a
// declaration, and Commander itself accepts none of it on the bare group command.
//
// Usage: node scripts/check-doc-claims.mjs [root]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();

const PRODUCTION_DIRS = ["src", "bin", "hooks", "installer"];
const CODE_DIRS = [...PRODUCTION_DIRS, "scripts", "test", ".github/workflows"];
const EXCLUDED_DOCS = /^(CHANGELOG\.md|\.changeset\/|docs\/design\/|plans\/|bundle\/)/;

// Flags Commander provides on (almost) every command, whether or not the source explicitly
// re-declares them: -V/--version is set once on `program`, and every subcommand keeps
// Commander's automatic -h/--help unless it calls `.helpOption(false)` without replacing it.
// Modelling that per-path exactly would mean tracking every `.helpOption(false)` call; since
// that never gains us a real error (nobody hand-types a wrong --help), we treat both as free.
const FREE_FLAGS = new Set(["--help", "--version"]);

// LCM_* variables read only by tests, scripts, or CI — not by production code — and
// deliberately left undocumented. Each is here because it failed the split in the header:
// it appears under test/, scripts/, or .github/, and nowhere under src/, bin/, hooks/, or
// installer/. A variable production code reads is never listed here.
const INTERNAL_ENV = new Set([
  "LCM_BENCH_CORPORA", // scripts/bench-corpora.mts: which corpora to build a bench from
  "LCM_BENCH_GROUP", // scripts/bench-corpora.mts: corpus group filter
  "LCM_BENCH_N", // scripts/bench-corpora.mts: question count for a generated bench
  "LCM_BENCH_SEED", // scripts/bench-corpora.mts: sampling seed for a generated bench
  "LCM_BLOCK", // test/doctor/doctor-hooks.test.ts: a local test constant, not an env read
  "LCM_CODEX_NATIVE_BIN", // test/e2e/flows/codex-native-runtime.test.ts: codex binary override
  "LCM_CODEX_NATIVE_RUNTIME", // test/e2e/flows/codex-native-runtime.test.ts: opts into that e2e flow
  "LCM_EVAL_API_KEY", // test/bench summarizer-eval harness: API key for the eval provider
  "LCM_EVAL_BASE_URL", // test/bench summarizer-eval harness: eval provider base URL
  "LCM_EVAL_CORPUS_DIR", // test/bench summarizer-eval harness: corpus directory to eval against
  "LCM_EVAL_DISABLE_THINKING", // test/bench summarizer-eval harness: disables provider thinking mode
  "LCM_EVAL_MODEL", // test/bench summarizer-eval harness: model under evaluation
  "LCM_EVAL_PROVIDER", // test/bench summarizer-eval harness: which provider to evaluate
  "LCM_EVAL_REASONING", // test/bench summarizer-eval harness: reasoning mode toggle
  "LCM_EVAL_REASONING_EFFORT", // test/bench summarizer-eval harness: reasoning effort level
  "LCM_EVAL_RUNS", // test/bench summarizer-eval harness: number of eval runs
  "LCM_EVAL_SESSIONS", // test/bench summarizer-eval harness: session count for the eval
  "LCM_REAL_BENCH_FILE", // test/bench/real-corpus.test.ts: fixed bench file for the real-corpus test
  "LCM_REAL_BENCH_PROJECT", // test/bench/real-corpus.test.ts: fixed project for the real-corpus test
  "LCM_SKIP_CACHE_SYNC", // scripts/sync-plugin-cache.sh + ci.yml: skip the plugin cache sync step
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function trackedDocs(rootDir) {
  const list = execFileSync("git", ["ls-files", "--", "*.md"], { cwd: rootDir, encoding: "utf8" });
  return list
    .split("\n")
    .filter((f) => f && !EXCLUDED_DOCS.test(f))
    // Deleted in the working tree but not yet staged: no longer a document.
    .filter((f) => existsSync(join(rootDir, f)));
}

// Text a reader is told to type: inline code spans and fenced blocks, with line numbers.
function codeLines(text) {
  const out = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      // A shell comment inside a block is prose, not something to type.
      out.push({ n: i + 1, text: line.replace(/(^|\s)#.*$/, "") });
      return;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ n: i + 1, text: m[1] });
  });
  return out;
}

// Finds the end of the statement that starts at `startIndex` (which must sit exactly on the
// first character of a chain root such as `program.command(` or `const x = new Command(`):
// scans forward tracking bracket depth and string/template state, stopping at the first `;`
// seen once depth returns to zero. This is a chain root's own statement regardless of what
// surrounds it in the file — nested arrow-function bodies (`.action(async (opts) => {...})`)
// stay inside the bracket depth and never trip an early split.
function statementAt(text, startIndex) {
  let depth = 0;
  let inStr = null;
  for (let i = startIndex; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return text.slice(startIndex, i);
  }
  return text.slice(startIndex);
}

// The bracketed region starting at `openIndex` (`{`, `[` or `(`), matching brackets of any
// kind and skipping over strings, up to and including its own closing bracket — unlike
// `statementAt`, this stops at balance, not at the next top-level `;` (a `const HELP = {...}`
// map has no semicolon between entries, so a per-entry statement scan would run past the
// entry's own closing brace and into every entry that follows it; likewise an `options: [`
// array whose own entries are themselves arrays needs bracket balance, not "the next `],`").
function balancedBraceBlock(text, openBraceIndex) {
  let depth = 0;
  let inStr = null;
  for (let i = openBraceIndex; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  return text.slice(openBraceIndex);
}

// Long flags (`--foo`, ignoring a leading `-x, ` alias) declared by `.option(...)`,
// `.requiredOption(...)` or `.addOption(new Option(...))` within one statement's text.
function flagsInStatement(stmt) {
  const flags = new Set();
  const specRe = /\.(?:option|requiredOption)\(\s*["'`]([^"'`]+)["'`]|\.addOption\(\s*new Option\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of stmt.matchAll(specRe)) {
    const spec = m[1] ?? m[2];
    for (const f of spec.matchAll(/--[a-z][a-z0-9-]+/g)) flags.add(f[0]);
  }
  return flags;
}

// Builds { pathOptions: Map<"daemon start", Set<flag>>, pathSet: Set<path>, globalFlags: Set }
// from bin/lcm.ts. `pathSet` includes intermediate group paths (`daemon`, `connectors`,
// `bench`, `sensitive`) as well as leaves, since each is itself a valid thing to type.
function parseBinLcm(text) {
  const pathOptions = new Map();
  const pathSet = new Set();
  const globalFlags = new Set();
  const varPath = new Map([["program", []]]);

  const addOptions = (path, flags) => {
    const key = path.join(" ");
    pathSet.add(key);
    if (!pathOptions.has(key)) pathOptions.set(key, new Set());
    for (const f of flags) pathOptions.get(key).add(f);
  };

  // Pass 1: every `new Command("name")` (optionally unnamed, i.e. the root `program`)
  // assigned to a variable, and what its own statement declares directly on it.
  const newCommandRe = /const\s+(\w+)\s*=\s*new Command\(\s*(?:["'`]([a-z][a-z0-9-]*)["'`])?\s*\)/g;
  for (const m of text.matchAll(newCommandRe)) {
    const [varName, cmdName] = [m[1], m[2]];
    const path = cmdName ? [cmdName] : [];
    varPath.set(varName, path);
    if (path.length > 0) addOptions(path, flagsInStatement(statementAt(text, m.index)));
  }

  // Pass 2: `<ident>.addCommand(<child>)` — re-home a child under its real parent. In this
  // file every addCommand target is `program`, so this is a safety net for future nesting.
  for (const m of text.matchAll(/\b(\w+)\.addCommand\(\s*(\w+)\s*\)/g)) {
    const [parentVar, childVar] = [m[1], m[2]];
    if (varPath.has(parentVar) && varPath.has(childVar)) {
      varPath.set(childVar, [...varPath.get(parentVar), ...varPath.get(childVar)]);
    }
  }

  // `program`'s own `.version(value, "-V, --version")` — the one Commander-native global
  // option — wherever it falls in program's declaration chain.
  const versionMatch = text.match(/\bprogram\b[\s\S]*?\.version\(\s*[^,]+,\s*["'`]([^"'`]+)["'`]/);
  if (versionMatch) for (const f of versionMatch[1].matchAll(/--[a-z][a-z0-9-]+/g)) globalFlags.add(f[0]);

  // Pass 3: every `<ident>.command("name")` chain root — a leaf reachable as
  // `varPath[ident] + name` — and every bare `<ident>.option(...)`-style statement not part
  // of a `.command()` chain, which declares options on the ident's own (parent) path. The
  // ident and its dot may be separated by the newline this file's chained style always puts
  // between a chain's root and its first call (`program\n  .command(...)`).
  const identStmtRe = /\b(\w+)\s*\.\s*(command|option|requiredOption|addOption|helpOption)\(/g;
  for (const m of text.matchAll(identStmtRe)) {
    const ident = m[1];
    const method = m[2];
    const stmt = statementAt(text, m.index);
    if (method === "command") {
      const cm = stmt.match(/^\w+\s*\.\s*command\(\s*["'`]([a-z][a-z0-9-]*)/);
      if (!cm) continue;
      const base = varPath.has(ident) ? varPath.get(ident) : [];
      addOptions([...base, cm[1]], flagsInStatement(stmt));
    } else if (!/\.command\(/.test(stmt.slice(0, stmt.indexOf(`.${method}(`) + 1))) {
      // A bare option statement on `ident` (no `.command(` earlier in the same statement):
      // it belongs to ident's own path, e.g. `daemonCmd.helpOption(false).option("-h",...)`.
      const base = varPath.has(ident) ? varPath.get(ident) : undefined;
      if (base !== undefined) addOptions(base, flagsInStatement(stmt));
    }
  }

  // A bare `program.option(...)` (declared before any subcommand, on `program` itself, base
  // path `[]`) is a global option by the same reasoning as `.version()` — Commander applies
  // it however the CLI is invoked. Fold its key (`""`) out of pathSet/pathOptions and into
  // globalFlags rather than leaving a phantom empty-string command path.
  for (const f of pathOptions.get("") ?? []) globalFlags.add(f);
  pathOptions.delete("");
  pathSet.delete("");

  return { pathOptions, pathSet, globalFlags };
}

// Parses src/cli-help.ts's hand-written HELP option lines. Each `[flagText, description]`
// entry either starts with a bare word naming a hand-parsed subcommand (`"purge [--all]
// [--yes]"`) — those attach to `lcm <section> <word>` — or starts directly with a flag
// (`"--dry-run"`) — those attach to the section's own bare path (`lcm <section>`), but only
// when bin/lcm.ts declares no real `<section> <child>` command: `sensitive` has none (it
// hand-parses its own args), so its direct flags are real; `daemon`, `connectors` and `bench`
// all have Commander subcommands of their own, and cli-help.ts's `daemon:` entry lists every
// subcommand's flags flattened onto one bare list for the reader — Commander itself accepts
// none of them on bare `lcm daemon`, so those would turn a real "unknown option" into a
// false pass. This is how `sensitive purge --yes` gets checked even though Commander never
// sees "purge" as its own command.
function parseCliHelp(text, binPathSet) {
  const pathOptions = new Map();
  const pathSet = new Set();
  const hasCommanderChildren = (section) => [...binPathSet].some((p) => p.startsWith(`${section} `));

  // Anchored to the start of a line (own indentation only): a HELP entry key always opens
  // its object right there (`install: {`, `"import-knowledge": {`), which keeps this from
  // matching a `word: {` substring that only happens to appear inside a description string.
  const helpBlockRe = /^[ \t]*(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9-]*)):\s*\{\s*$/gm;
  let m;
  while ((m = helpBlockRe.exec(text))) {
    const section = m[1] ?? m[2];
    const block = balancedBraceBlock(text, m.index + m[0].length - 1); // from the opening `{`
    const optionsKey = block.match(/options:\s*\[/);
    if (!optionsKey) continue;
    const optionsArray = balancedBraceBlock(block, optionsKey.index + optionsKey[0].length - 1);
    // The flag-text string's own delimiter (`'`, `"` or `` ` ``) is captured and reused to
    // bound its content, so a backtick string containing literal double quotes (`` `add
    // "<pattern>" [--global]` ``) is read whole rather than truncated at its first `"`.
    for (const om of optionsArray.matchAll(/\[\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
      const flagText = om[2];
      const leading = flagText.match(/^([a-z][a-z0-9-]*)\b/);
      const flags = [...flagText.matchAll(/--[a-z][a-z0-9-]+/g)].map((f) => f[0]);
      if (flags.length === 0) continue;
      const isBareFlags = !leading || flagText.startsWith("--");
      if (isBareFlags && hasCommanderChildren(section)) continue;
      const path = isBareFlags ? [section] : [section, leading[1]];
      const key = path.join(" ");
      pathSet.add(key);
      if (!pathOptions.has(key)) pathOptions.set(key, new Set());
      for (const f of flags) pathOptions.get(key).add(f);
    }
  }
  return { pathOptions, pathSet };
}

// bin/lcm.ts, plus every src/cli/<name>.ts (sorted, only ones that exist) — the files a
// future PR moves command registrations into. `src/cli-help.ts` is deliberately excluded:
// it is the hand-written help source, never a command declaration.
function commandSourceFiles(rootDir) {
  const files = ["bin/lcm.ts"];
  let cliDirEntries;
  try {
    cliDirEntries = readdirSync(join(rootDir, "src/cli"), { withFileTypes: true });
  } catch {
    cliDirEntries = [];
  }
  const cliFiles = cliDirEntries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => `src/cli/${e.name}`)
    .sort();
  files.push(...cliFiles);
  return files.filter((rel) => existsSync(join(rootDir, rel)));
}

// Adds `flags` to `pathOptions[path]`, creating that path's option set on first use.
function addFlagsToPath(pathOptions, path, flags) {
  if (!pathOptions.has(path)) pathOptions.set(path, new Set());
  for (const f of flags) pathOptions.get(path).add(f);
}

// Merges per-file command surfaces (each from `parseBinLcm`) into one: command paths union,
// each path's options union, global flags union. A path declared in more than one file (not
// expected today, but not assumed impossible) simply gets the combined option set.
function mergeCommandSurfaces(surfaces) {
  const pathOptions = new Map();
  const pathSet = new Set();
  const globalFlags = new Set();
  for (const s of surfaces) {
    for (const p of s.pathSet) pathSet.add(p);
    for (const [path, flags] of s.pathOptions) addFlagsToPath(pathOptions, path, flags);
    for (const f of s.globalFlags) globalFlags.add(f);
  }
  return { pathOptions, pathSet, globalFlags };
}

function cliSurface(rootDir) {
  const sourceFiles = commandSourceFiles(rootDir);
  const perFile = sourceFiles.map((rel) => parseBinLcm(readFileSync(join(rootDir, rel), "utf8")));
  const bin = mergeCommandSurfaces(perFile);

  const helpText = readFileSync(join(rootDir, "src/cli-help.ts"), "utf8");
  const help = parseCliHelp(helpText, bin.pathSet);

  const pathSet = new Set([...bin.pathSet, ...help.pathSet]);
  const pathOptions = new Map();
  for (const key of pathSet) {
    const merged = new Set([...(bin.pathOptions.get(key) ?? []), ...(help.pathOptions.get(key) ?? [])]);
    pathOptions.set(key, merged);
  }
  return { pathOptions, pathSet, globalFlags: bin.globalFlags };
}

function tokensUnder(rootDir, dirs) {
  const tokens = new Set();
  for (const dir of dirs) {
    for (const file of walk(join(rootDir, dir))) {
      if (statSync(file).size > 2_000_000) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bLCM_[A-Z0-9_]*[A-Z0-9]\b/g)) tokens.add(m[0]);
    }
  }
  return tokens;
}

// `all`: every LCM_* token anywhere under CODE_DIRS (what an undeclared-variable error is
// checked against). `production`: the same, restricted to PRODUCTION_DIRS — a variable in
// this set is one production code actually reads, so INTERNAL_ENV can never silence its
// "no document mentions it" warning for it, no matter what the hand-curated list says.
function envSurface(rootDir) {
  return { all: tokensUnder(rootDir, CODE_DIRS), production: tokensUnder(rootDir, PRODUCTION_DIRS) };
}

function mcpSurface(rootDir) {
  const dir = join(rootDir, "src/mcp/tools");
  const names = new Set();
  for (const file of walk(dir)) {
    const m = readFileSync(file, "utf8").match(/name:\s*["'`](lcm_[a-z_]+)["'`]/);
    if (m) names.add(m[1]);
  }
  return names;
}

// Splits a document line into one substring per `lcm` invocation, each running up to (but
// not including) the next `lcm` token, `|`, `;`, `&&`, or end of line — so flags on one
// invocation are never checked against a different one on the same line.
function invocationSegments(line) {
  const starts = [...line.matchAll(/\blcm\b/g)].map((m) => m.index);
  const segments = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    let end = i + 1 < starts.length ? starts[i + 1] : line.length;
    const rest = line.slice(start, end);
    const sep = rest.match(/\||;|&&/);
    if (sep) end = start + sep.index;
    segments.push(line.slice(start, end));
  }
  return segments;
}

// Resolves the longest known command path at the start of a segment (after `lcm`), e.g.
// "daemon start" over "daemon" when both are declared. Returns { path, matched, words }.
function resolvePath(segment, pathSet) {
  let rest = segment.replace(/^\s*lcm\b/, "");
  const words = [];
  for (let i = 0; i < 4; i++) {
    const wm = rest.match(/^\s+([a-z][a-z0-9-]*)\b/);
    if (!wm) break;
    words.push(wm[1]);
    rest = rest.slice(wm[0].length);
  }
  for (let len = words.length; len >= 1; len--) {
    const candidate = words.slice(0, len).join(" ");
    if (pathSet.has(candidate)) return { path: candidate, matched: true, words };
  }
  return { path: words[0], matched: false, words };
}

function checkDocClaims(rootDir) {
  const errors = [];
  const warnings = [];
  const docs = trackedDocs(rootDir);
  const cli = cliSurface(rootDir);
  const env = envSurface(rootDir);
  const mcp = mcpSurface(rootDir);

  if (docs.length === 0) errors.push("no tracked Markdown found — the file walk is wrong, not the docs");
  if (cli.pathSet.size === 0) errors.push("CLI surface is empty — the extraction is wrong, not the docs");
  if (env.all.size === 0) errors.push("no LCM_* token found in the code — the extraction is wrong, not the docs");
  if (mcp.size === 0) errors.push("no MCP tool found under src/mcp/tools — the extraction is wrong, not the docs");
  if (errors.length) return { errors, warnings };

  const mentionedFlagsByPath = new Map();
  const mentionedEnv = new Set();

  for (const rel of docs) {
    const text = readFileSync(join(rootDir, rel), "utf8");

    for (const { n, text: line } of codeLines(text)) {
      for (const segment of invocationSegments(line)) {
        const { path, matched, words } = resolvePath(segment, cli.pathSet);
        if (words.length === 0) continue;
        if (!matched) {
          errors.push(`${rel}:${n}: \`lcm ${words[0]}\` — the CLI defines no subcommand "${words[0]}"`);
        }
        const allowed = matched ? cli.pathOptions.get(path) ?? new Set() : new Set();
        if (matched && !mentionedFlagsByPath.has(path)) mentionedFlagsByPath.set(path, new Set());
        for (const f of segment.matchAll(/--[a-z][a-z0-9-]+/g)) {
          const flag = f[0];
          if (matched) mentionedFlagsByPath.get(path).add(flag);
          if (!allowed.has(flag) && !cli.globalFlags.has(flag) && !FREE_FLAGS.has(flag)) {
            const where = matched ? `lcm ${path}` : `lcm ${words[0]}`;
            errors.push(`${rel}:${n}: \`${flag}\` — \`${where}\` defines no such option`);
          }
        }
      }
    }

    for (const m of text.matchAll(/\bLCM_[A-Z0-9_]*[A-Z0-9]\b(?!\*)/g)) {
      mentionedEnv.add(m[0]);
      if (!env.all.has(m[0])) {
        const n = text.slice(0, m.index).split("\n").length;
        errors.push(`${rel}:${n}: ${m[0]} — nothing in ${CODE_DIRS.join(", ")} reads this variable`);
      }
    }

    for (const m of text.matchAll(/\blcm_[a-z_]+\b/g)) {
      if (!mcp.has(m[0])) {
        const n = text.slice(0, m.index).split("\n").length;
        errors.push(`${rel}:${n}: ${m[0]} — src/mcp/tools defines no such tool`);
      }
    }
  }

  for (const path of [...cli.pathSet].sort()) {
    const flags = cli.pathOptions.get(path) ?? new Set();
    const mentioned = mentionedFlagsByPath.get(path) ?? new Set();
    for (const flag of [...flags].sort()) {
      if (!mentioned.has(flag) && !cli.globalFlags.has(flag) && !FREE_FLAGS.has(flag)) {
        warnings.push(`lcm ${path} ${flag} is not mentioned by any tracked document`);
      }
    }
  }
  const publicEnv = [...env.all]
    .filter((v) => /^LCM_[A-Z0-9_]+$/.test(v) && !(INTERNAL_ENV.has(v) && !env.production.has(v)))
    .sort();
  for (const v of publicEnv) {
    if (!mentionedEnv.has(v)) warnings.push(`${v} is read by the code but no tracked document mentions it`);
  }

  const totalFlags = [...cli.pathOptions.values()].reduce((n, s) => n + s.size, 0);
  return {
    errors,
    warnings,
    counts: { docs: docs.length, paths: cli.pathSet.size, flags: totalFlags, env: env.all.size, mcp: mcp.size },
  };
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const { errors, warnings, counts } = checkDocClaims(root);
  const annotate = process.env.GITHUB_ACTIONS ? (w) => `::warning title=check-doc-claims::${w}` : (w) => `  ! ${w}`;
  for (const w of warnings) console.log(annotate(w));
  if (errors.length > 0) {
    console.error(`check-doc-claims: ${errors.length} claim(s) the code does not back:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`check-doc-claims: OK (${counts.docs} documents against ${counts.paths} command paths, ${counts.flags} options, ${counts.env} env tokens, ${counts.mcp} MCP tools; ${warnings.length} warning(s))`);
}

export { checkDocClaims };
