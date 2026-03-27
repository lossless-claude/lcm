import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GITLEAKS_PATTERNS } from "./generated-patterns.js";

const _thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * Reads the sync date from the generated-patterns.ts header comment.
 * Returns a formatted date string like "2026-03-27" or null if unavailable.
 */
export function readGitleaksSyncDate(): string | null {
  try {
    const genFile = join(_thisDir, "generated-patterns.js");
    if (!existsSync(genFile)) return null;
    const header = readFileSync(genFile, "utf-8").slice(0, 500);
    const match = header.match(/\/\/ Updated: (\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
/**
 * Native (hand-curated) patterns that gap-fill what gitleaks doesn't cover.
 * These are applied in addition to GITLEAKS_PATTERNS.
 *
 * Merge order: GITLEAKS_PATTERNS → NATIVE_PATTERNS → globalUserPatterns → projectPatterns
 */
export const NATIVE_PATTERNS: string[] = [
  // OpenAI / generic sk- keys (gitleaks covers these but with context — add bare form)
  "sk-[A-Za-z0-9]{20,}",
  // Anthropic keys
  "sk-ant-[A-Za-z0-9\\-]{40,}",
  // GitHub PATs (bare form — gitleaks covers with context)
  "ghp_[A-Za-z0-9]{36}",
  // AWS access key IDs (bare form)
  "AKIA[0-9A-Z]{16}",
  // PEM key headers
  "-----BEGIN .* KEY-----",
  // Bearer tokens (authorization header value)
  "Bearer [A-Za-z0-9\\-._~+/]+=*",
  // Password assignments
  "[Pp]assword\\s*[:=]\\s*\\S+",
  // npm tokens (classic npm_ prefix — revoked Dec 2025 but may exist in old configs)
  "npm_[A-Za-z0-9]{30,}",
  // Slack tokens: bot (xoxb), user (xoxp), workspace (xoxa), owner (xoxo),
  // session (xoxs), rotating (xoxe), refresh (xoxr)
  "xox[bpoasre]-[A-Za-z0-9\\-]+",
  // Slack app-level tokens (xapp-) and workflow tokens (xwfp-)
  "xapp-[A-Za-z0-9\\-]+",
  "xwfp-[A-Za-z0-9\\-]+",
  // Stripe live keys (secret, publishable, restricted)
  "[spr]k_live_[A-Za-z0-9]{16,}",
  // Google/GCP API keys (deterministic AIza prefix)
  "AIza[\\w-]{35}",
  // SendGrid API tokens (SG. prefix, 66-char body)
  "SG\\.[a-zA-Z0-9=_\\-.]{66}",
  // Twilio API keys (SK prefix + 32 hex chars)
  "SK[0-9a-fA-F]{32}",
  // Shopify access tokens (shpat_, shpca_, shppa_, shpss_ prefixes)
  "shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}",
  // HashiCorp Vault service tokens (hvs. prefix)
  "hvs\\.[\\w-]{90,120}",
  // Doppler API tokens (dp.pt. prefix)
  "dp\\.pt\\.[a-z0-9]{43}",
  // Database connection strings with embedded credentials
  "(postgres|mysql|mongodb|redis|rediss)://\\S+:\\S+@\\S+",
  // JSON Web Tokens (three base64url segments separated by dots)
  "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
];

/**
 * @deprecated Use NATIVE_PATTERNS instead. Kept for backward compatibility.
 */
export const BUILT_IN_PATTERNS: string[] = NATIVE_PATTERNS;

/**
 * Returns true if a regex pattern source can match across whitespace boundaries.
 * Patterns containing a literal space, \s, or a dot (which matches space) are
 * considered "spanning" and will be applied to the full text rather than
 * token-by-token.
 */
function isSpanningPattern(source: string): boolean {
  // Check for literal space or the escape sequence \s — unambiguous spanning intent.
  // Use string includes (not regex) so we detect the two-char sequence \s, not whitespace chars.
  if (source.includes(" ") || source.includes("\\s")) return true;
  // Check for unescaped `.` which can match spaces
  // Walk the source and look for `.` not preceded by `\`
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (source[i] === ".") return true;
  }
  return false;
}

export interface ScrubCounts {
  text: string;
  gitleaks: number;
  builtIn: number;
  global: number;
  project: number;
}

/** Gitleaks sync date extracted from generated file header (ISO string or null). */
export function getGitleaksSyncDate(): string | null {
  // Import the generated file's header comment to extract the sync date.
  // We parse it from the module-level comment using a regex on the import URL.
  // Since we can't read import comments at runtime, we embed it via the GITLEAKS_PATTERNS array length check.
  // The date is exposed via the module's comment; callers can read it via readGitleaksSyncDate().
  return null;
}

export class ScrubEngine {
  private readonly spanningPatterns: Array<{ source: string; regex: RegExp }> = [];
  private readonly tokenPatterns: Array<{ source: string; regex: RegExp }> = [];
  /**
   * Original index (into the combined [gitleaks, native, global, project] array) for each spanning pattern.
   * Gitleaks patterns are always "spanning" (applied to full text regardless of isSpanningPattern).
   */
  private readonly _spanningOrigIdx: number[] = [];
  /** Original index for each token pattern. */
  private readonly _tokenOrigIdx: number[] = [];
  /** Number of gitleaks patterns at the start of the combined array. */
  private readonly _gitleaksCount: number;
  /** Number of native (built-in) patterns after gitleaks. */
  private readonly _nativeCount: number;
  /** Number of global patterns (for category accounting). */
  private readonly _globalPatternCount: number;
  readonly invalidPatterns: string[] = [];

  constructor(globalPatterns: string[], projectPatterns: string[]) {
    this._gitleaksCount = GITLEAKS_PATTERNS.length;
    this._nativeCount = NATIVE_PATTERNS.length;
    this._globalPatternCount = globalPatterns.length;

    // Merge order: gitleaks → native → global → project
    const all: Array<{ source: string; isGitleaks: boolean; flags: string }> = [
      ...GITLEAKS_PATTERNS.map((p) => ({ source: p.regex, isGitleaks: true, flags: p.flags })),
      ...NATIVE_PATTERNS.map((p) => ({ source: p, isGitleaks: false, flags: "" })),
      ...globalPatterns.map((p) => ({ source: p, isGitleaks: false, flags: "" })),
      ...projectPatterns.map((p) => ({ source: p, isGitleaks: false, flags: "" })),
    ];

    for (let i = 0; i < all.length; i++) {
      const { source, isGitleaks, flags } = all[i];
      try {
        const regex = new RegExp(source, "g" + flags);
        // Gitleaks patterns always run against full text (bypass spanning check)
        if (isGitleaks || isSpanningPattern(source)) {
          this.spanningPatterns.push({ source, regex });
          this._spanningOrigIdx.push(i);
        } else {
          this.tokenPatterns.push({ source, regex });
          this._tokenOrigIdx.push(i);
        }
      } catch {
        this.invalidPatterns.push(source);
      }
    }
  }

  /**
   * Redact all matching patterns in text, returning the scrubbed text along
   * with per-category counts of how many redactions were made.
   *
   * Strategy:
   * - Gitleaks patterns are always applied to the full text (they're pre-vetted
   *   for full-text scanning and many contain `.` for key-value matching).
   * - "Spanning" native/user patterns (those that can match across whitespace)
   *   are applied to the full text via a multi-range merge.
   * - "Token" native/user patterns (no whitespace/dot in source) are applied
   *   token-by-token so that greedy `.*`-style patterns don't eat adjacent tokens.
   */
  scrubWithCounts(text: string): ScrubCounts {
    const gitleaksCount = this._gitleaksCount;
    const nativeCount = this._nativeCount;
    const globalCount = this._globalPatternCount;

    // Step 1: collect ranges from spanning patterns applied to full text
    // (includes all gitleaks patterns + spanning native/user patterns)
    type TaggedRange = { range: [number, number]; idx: number };
    const taggedRanges: TaggedRange[] = [];
    for (let pi = 0; pi < this.spanningPatterns.length; pi++) {
      const { regex } = this.spanningPatterns[pi];
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        taggedRanges.push({ range: [m.index, m.index + m[0].length], idx: this._spanningOrigIdx[pi] });
        if (m[0].length === 0) regex.lastIndex++;
      }
    }

    // Step 2: apply token patterns per whitespace-separated segment
    const segments = text.split(/(\s+)/);
    let offset = 0;
    for (const seg of segments) {
      if (!/^\s+$/.test(seg) && this.tokenPatterns.length > 0) {
        for (let pi = 0; pi < this.tokenPatterns.length; pi++) {
          const { regex } = this.tokenPatterns[pi];
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(seg)) !== null) {
            taggedRanges.push({ range: [offset + m.index, offset + m.index + m[0].length], idx: this._tokenOrigIdx[pi] });
            if (m[0].length === 0) regex.lastIndex++;
          }
        }
      }
      offset += seg.length;
    }

    if (taggedRanges.length === 0) return { text, gitleaks: 0, builtIn: 0, global: 0, project: 0 };

    // Sort by start position
    taggedRanges.sort((a, b) => a.range[0] - b.range[0]);

    // Merge overlapping ranges; when overlaps occur, the lowest original pattern
    // index wins so that gitleaks > native > global > project and earlier patterns win.
    const merged: Array<{ range: [number, number]; idx: number }> = [];
    let cur = taggedRanges[0];
    for (let i = 1; i < taggedRanges.length; i++) {
      const next = taggedRanges[i];
      if (next.range[0] <= cur.range[1]) {
        cur = { range: [cur.range[0], Math.max(cur.range[1], next.range[1])], idx: Math.min(cur.idx, next.idx) };
      } else {
        merged.push(cur);
        cur = next;
      }
    }
    merged.push(cur);

    // Count redactions by category
    let gitleaks = 0;
    let builtIn = 0;
    let global = 0;
    let project = 0;
    for (const { idx } of merged) {
      if (idx < gitleaksCount) gitleaks++;
      else if (idx < gitleaksCount + nativeCount) builtIn++;
      else if (idx < gitleaksCount + nativeCount + globalCount) global++;
      else project++;
    }

    // Build result string
    let result = "";
    let pos = 0;
    for (const { range: [s, e] } of merged) {
      result += text.slice(pos, s) + "[REDACTED]";
      pos = e;
    }
    result += text.slice(pos);
    return { text: result, gitleaks, builtIn, global, project };
  }

  /**
   * Redact all matching patterns in text, replacing matches with [REDACTED].
   *
   * Strategy:
   * - Gitleaks patterns always applied to full text.
   * - "Spanning" native/user patterns applied to full text.
   * - "Token" patterns applied token-by-token.
   */
  scrub(text: string): string {
    return this.scrubWithCounts(text).text;
  }

  /** Parse a sensitive-patterns.txt file. Returns empty array if file is absent. */
  static async loadProjectPatterns(filePath: string): Promise<string[]> {
    try {
      const content = await readFile(filePath, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Build a ScrubEngine for a given project directory. */
  static async forProject(
    globalPatterns: string[],
    projectDir: string,
  ): Promise<ScrubEngine> {
    const projectPatterns = await ScrubEngine.loadProjectPatterns(
      join(projectDir, "sensitive-patterns.txt"),
    );
    return new ScrubEngine(globalPatterns, projectPatterns);
  }
}
