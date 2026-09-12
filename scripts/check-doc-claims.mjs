#!/usr/bin/env node
// Checks that what the tracked Markdown tells a reader to type exists in the code.
//
// Three claim types, each exact and cheap:
//   (a) `lcm <subcommand> --flag` inside a code span or fenced block, against bin/lcm.ts
//       and src/cli-help.ts;
//   (b) an `LCM_*` environment variable, against every LCM_* token the code, scripts,
//       tests and workflows read;
//   (c) an `lcm_*` MCP tool name, against src/mcp/tools/*.ts.
//
// A claim the code does not back is an error and fails the run. The reverse direction —
// a CLI flag or env var the code defines that no document mentions — is a warning, because
// whether a knob is public is a judgement this script cannot make.
//
// Coverage comes from `git ls-files`, never from a list written by hand. Excluded on
// purpose: CHANGELOG.md and .changeset/ (records of the past), docs/design/ (proposals),
// plans/ (untracked working notes).
//
// Both sides abort when empty: an empty code side would pass every claim, which is the
// exact failure this script exists to catch.
//
// Usage: node scripts/check-doc-claims.mjs [root]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();

// bin/lcm.ts declares Commander options; src/cli-help.ts is the CLI's own help text, which is
// where hand-parsed subcommands (`sensitive purge --yes`) and hidden options (`compact --hook`)
// state their flags.
const CLI_SOURCES = ["bin/lcm.ts", "src/cli-help.ts"];
const CODE_DIRS = ["src", "bin", "hooks", "installer", "scripts", "test", ".github/workflows"];
const EXCLUDED_DOCS = /^(CHANGELOG\.md|\.changeset\/|docs\/design\/|plans\/)/;
// Flags Commander provides on every command.
const FREE_FLAGS = new Set(["--help", "--version"]);
// Words that follow `lcm` in code spans without naming a subcommand.
const NOT_SUBCOMMANDS = new Set(["daemon"]); // `lcm daemon` is `new Command("daemon")`, handled below

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

function trackedDocs() {
  const list = execFileSync("git", ["ls-files", "--", "*.md"], { cwd: root, encoding: "utf8" });
  return list
    .split("\n")
    .filter((f) => f && !EXCLUDED_DOCS.test(f))
    // Deleted in the working tree but not yet staged: no longer a document.
    .filter((f) => existsSync(join(root, f)));
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

function cliSurface() {
  const cli = CLI_SOURCES.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const subs = new Set([
    ...[...cli.matchAll(/\.command\(\s*["'`]([a-z][a-z0-9-]*)/g)].map((m) => m[1]),
    ...[...cli.matchAll(/new Command\(\s*["'`]([a-z][a-z0-9-]*)/g)].map((m) => m[1]),
  ]);
  const flags = new Set([...cli.matchAll(/--[a-z][a-z0-9-]+/g)].map((m) => m[0]));
  return { subs, flags };
}

function envSurface() {
  const tokens = new Set();
  for (const dir of CODE_DIRS) {
    for (const file of walk(join(root, dir))) {
      if (statSync(file).size > 2_000_000) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bLCM_[A-Z0-9_]*[A-Z0-9]\b/g)) tokens.add(m[0]);
    }
  }
  return tokens;
}

function mcpSurface() {
  const dir = join(root, "src/mcp/tools");
  const names = new Set();
  for (const file of walk(dir)) {
    const m = readFileSync(file, "utf8").match(/name:\s*["'`](lcm_[a-z_]+)["'`]/);
    if (m) names.add(m[1]);
  }
  return names;
}

function checkDocClaims(rootDir) {
  const errors = [];
  const warnings = [];
  const docs = trackedDocs();
  const cli = cliSurface();
  const env = envSurface();
  const mcp = mcpSurface();

  if (docs.length === 0) errors.push("no tracked Markdown found — the file walk is wrong, not the docs");
  if (cli.subs.size === 0 || cli.flags.size === 0) errors.push("CLI surface is empty — the extraction is wrong, not the docs");
  if (env.size === 0) errors.push("no LCM_* token found in the code — the extraction is wrong, not the docs");
  if (mcp.size === 0) errors.push("no MCP tool found under src/mcp/tools — the extraction is wrong, not the docs");
  if (errors.length) return { errors, warnings };

  const mentionedFlags = new Set();
  const mentionedEnv = new Set();

  for (const rel of docs) {
    const text = readFileSync(join(rootDir, rel), "utf8");

    for (const { n, text: line } of codeLines(text)) {
      // `lcm <sub>` at the start of a command position: line start, pipe, `;`, `&&`, `$(`, or a space.
      for (const m of line.matchAll(/(?:^|[\s|;&(])lcm\s+([a-z][a-z0-9-]*)/g)) {
        const sub = m[1];
        if (!cli.subs.has(sub) && !NOT_SUBCOMMANDS.has(sub)) {
          errors.push(`${rel}:${n}: \`lcm ${sub}\` — the CLI defines no subcommand "${sub}"`);
        }
        for (const f of line.matchAll(/--[a-z][a-z0-9-]+/g)) {
          const flag = f[0];
          mentionedFlags.add(flag);
          if (!cli.flags.has(flag) && !FREE_FLAGS.has(flag)) {
            errors.push(`${rel}:${n}: \`${flag}\` — the CLI defines no such option`);
          }
        }
      }
    }

    for (const m of text.matchAll(/\bLCM_[A-Z0-9_]*[A-Z0-9]\b(?!\*)/g)) {
      mentionedEnv.add(m[0]);
      if (!env.has(m[0])) {
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

  for (const flag of [...cli.flags].sort()) {
    if (!mentionedFlags.has(flag) && !FREE_FLAGS.has(flag)) warnings.push(`CLI option ${flag} is not mentioned by any tracked document`);
  }
  const publicEnv = [...env].filter((v) => /^LCM_[A-Z0-9_]+$/.test(v)).sort();
  for (const v of publicEnv) {
    if (!mentionedEnv.has(v)) warnings.push(`${v} is read by the code but no tracked document mentions it`);
  }

  return { errors, warnings, counts: { docs: docs.length, subs: cli.subs.size, flags: cli.flags.size, env: env.size, mcp: mcp.size } };
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
  console.log(`check-doc-claims: OK (${counts.docs} documents against ${counts.subs} subcommands, ${counts.flags} options, ${counts.env} env tokens, ${counts.mcp} MCP tools; ${warnings.length} warning(s))`);
}

export { checkDocClaims };
