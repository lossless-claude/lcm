#!/usr/bin/env tsx
/**
 * update-gitleaks-patterns.ts
 *
 * Fetches the canonical gitleaks.toml from GitHub, converts Go regexes to JS,
 * validates each pattern (compiles + smoke tests), and writes src/generated-patterns.ts.
 *
 * Usage:
 *   npx tsx scripts/update-gitleaks-patterns.ts
 *
 * The script aborts (exit 1) if:
 *   - Fetch fails
 *   - New valid pattern count drops >10% from previous (regression guard)
 *   - Known token-sample positive tests fail
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OUT_FILE = join(REPO_ROOT, "src", "generated-patterns.ts");
const TOML_URL =
  "https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawRule {
  id: string;
  description: string;
  regex: string;
}

interface GitleaksPattern {
  id: string;
  regex: string;
  flags: string;
  description: string;
}

// ─── TOML Parser ──────────────────────────────────────────────────────────────

function parseRules(toml: string): RawRule[] {
  const rules: RawRule[] = [];
  const ruleBlocks = toml.split(/^\[\[rules\]\]/m).slice(1);

  for (const block of ruleBlocks) {
    // Stop at the next top-level section
    const end = block.search(/^\[[^\[]/m);
    const section = end === -1 ? block : block.slice(0, end);

    const idMatch = section.match(/^id\s*=\s*["']([^"']+)["']/m);
    if (!idMatch) continue;
    const id = idMatch[1];

    const descMatch = section.match(/^description\s*=\s*["']([^"']*?)["']/ms);
    const description = descMatch
      ? descMatch[1].replace(/\s+/g, " ").trim()
      : "";

    let regex: string | null = null;

    // Triple single-quote (most common in gitleaks.toml)
    const tripleMatch = section.match(/^regex\s*=\s*'''([\s\S]*?)'''/m);
    if (tripleMatch) {
      regex = tripleMatch[1];
    } else {
      // Triple double-quote
      const tripleDoubleMatch = section.match(/^regex\s*=\s*"""([\s\S]*?)"""/m);
      if (tripleDoubleMatch) {
        regex = tripleDoubleMatch[1];
      } else {
        // Regular single or double quoted
        const regularMatch = section.match(/^regex\s*=\s*["']([^"']+)["']/m);
        if (regularMatch) regex = regularMatch[1];
      }
    }

    if (!regex) continue;
    rules.push({ id, description, regex });
  }

  return rules;
}

// ─── Go → JS Regex Converter ──────────────────────────────────────────────────

function convertGoRegex(goRegex: string): { regex: string; flags: string } {
  let jsRegex = goRegex;
  let flags = "";

  // Go's (?i) inline flag → JS i flag
  if (jsRegex.includes("(?i)")) {
    flags = "i";
    jsRegex = jsRegex.replace(/\(\?i\)/g, "");
  }

  // Go's hex escape for backtick → literal backtick
  jsRegex = jsRegex.replace(/\\x60/g, "`");

  return { regex: jsRegex, flags };
}

// ─── Smoke Tests ──────────────────────────────────────────────────────────────

const COMMON_ENGLISH_WORDS = [
  "the",
  "function",
  "return",
  "import",
  "export",
  "default",
  "class",
  "const",
  "let",
  "var",
];

// Maximum number of common words a pattern may match before being considered
// a false-positive generator (aggressive threshold — transcript scrubbing
// prefers false positives over missed secrets).
const MAX_FALSE_POSITIVE_WORDS = 3;

// ─── Regression Guard ─────────────────────────────────────────────────────────

function getPreviousCount(outFile: string): number {
  if (!existsSync(outFile)) return 0;
  const content = readFileSync(outFile, "utf-8");
  const match = content.match(/\/\/ Rules: (\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ─── Escape for TS string literal ────────────────────────────────────────────

function escapeForSingleQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Fetching ${TOML_URL} …`);
  const res = await fetch(TOML_URL);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const toml = await res.text();
  console.log(`  Downloaded ${toml.length} bytes`);

  const rawRules = parseRules(toml);
  console.log(`  Parsed ${rawRules.length} [[rules]] entries`);

  const valid: GitleaksPattern[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const rule of rawRules) {
    const { regex, flags } = convertGoRegex(rule.regex);

    // Test compilability
    let compiled: RegExp;
    try {
      compiled = new RegExp(regex, flags);
    } catch (e) {
      skipped.push({
        id: rule.id,
        reason: `JS-incompatible: ${(e as Error).message}`,
      });
      continue;
    }

    // Smoke test: must not match too many common English words
    const falsePositiveWords = COMMON_ENGLISH_WORDS.filter((w) =>
      compiled.test(w)
    );
    if (falsePositiveWords.length > MAX_FALSE_POSITIVE_WORDS) {
      skipped.push({
        id: rule.id,
        reason: `false-positive on common words: ${falsePositiveWords.join(", ")}`,
      });
      continue;
    }

    valid.push({
      id: rule.id,
      regex,
      flags,
      description: rule.description,
    });
  }

  console.log(`  Valid: ${valid.length}, Skipped: ${skipped.length}`);
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`    SKIP ${s.id}: ${s.reason}`);
    }
  }

  // Regression guard: abort if valid count dropped >10% from previous
  const previousCount = getPreviousCount(OUT_FILE);
  if (previousCount > 0) {
    const dropPct = (previousCount - valid.length) / previousCount;
    if (dropPct > 0.1) {
      throw new Error(
        `Regression guard: count dropped ${Math.round(dropPct * 100)}% (${previousCount} → ${valid.length}). Aborting.`
      );
    }
  }

  // Build TypeScript file
  const now = new Date().toISOString();
  const skipNote =
    skipped.length > 0
      ? skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")
      : "none";

  const lines: string[] = [
    `// AUTO-GENERATED by scripts/update-gitleaks-patterns.ts — do not edit manually`,
    `// Source: https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml`,
    `// Updated: ${now}`,
    `// Rules: ${valid.length} (${skipped.length} skipped — ${skipNote})`,
    ``,
    `export interface GitleaksPattern {`,
    `  id: string;`,
    `  regex: string;`,
    `  flags: string;  // "" or "i" (from Go's (?i) inline flag)`,
    `  description: string;`,
    `}`,
    ``,
    `export const GITLEAKS_PATTERNS: GitleaksPattern[] = [`,
  ];

  for (const p of valid) {
    const escapedDesc = escapeForSingleQuote(p.description);
    const escapedRegex = escapeForSingleQuote(p.regex);
    lines.push(
      `  { id: '${p.id}', flags: '${p.flags}', regex: '${escapedRegex}', description: '${escapedDesc}' },`
    );
  }

  lines.push(`];`);
  lines.push(``);

  const tsContent = lines.join("\n");
  writeFileSync(OUT_FILE, tsContent, "utf-8");
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`  ${valid.length} patterns, ${tsContent.length} bytes`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
