import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const BUILT_IN_PATTERNS: string[] = [
  "sk-[A-Za-z0-9]{20,}",
  "sk-ant-[A-Za-z0-9\\-]{40,}",
  "ghp_[A-Za-z0-9]{36}",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN .* KEY-----",
  "Bearer [A-Za-z0-9\\-._~+/]+=*",
  "[Pp]assword\\s*[:=]\\s*\\S+",
];

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
  builtIn: number;
  global: number;
  project: number;
}

export class ScrubEngine {
  private readonly spanningPatterns: Array<{ source: string; regex: RegExp }> = [];
  private readonly tokenPatterns: Array<{ source: string; regex: RegExp }> = [];
  /** Original index (into the combined [builtIn, global, project] array) for each spanning pattern. */
  private readonly _spanningOrigIdx: number[] = [];
  /** Original index for each token pattern. */
  private readonly _tokenOrigIdx: number[] = [];
  /** Number of global patterns (for category accounting). */
  private readonly _globalPatternCount: number;
  readonly invalidPatterns: string[] = [];

  constructor(globalPatterns: string[], projectPatterns: string[]) {
    this._globalPatternCount = globalPatterns.length;
    const all = [...BUILT_IN_PATTERNS, ...globalPatterns, ...projectPatterns];
    for (let i = 0; i < all.length; i++) {
      const source = all[i];
      try {
        const regex = new RegExp(source, "g");
        if (isSpanningPattern(source)) {
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
   * - "Spanning" patterns (those that can match across whitespace) are applied
   *   to the full text via a multi-range merge to avoid one pattern consuming
   *   another's matches.
   * - "Token" patterns (no whitespace/dot in source) are applied token-by-token
   *   so that greedy `.*`-style patterns in one token don't eat adjacent tokens.
   */
  scrubWithCounts(text: string): ScrubCounts {
    const builtInCount = BUILT_IN_PATTERNS.length;
    const globalCount = this._globalPatternCount;

    // Step 1: collect ranges from spanning patterns applied to full text
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

    if (taggedRanges.length === 0) return { text, builtIn: 0, global: 0, project: 0 };

    // Sort by start position
    taggedRanges.sort((a, b) => a.range[0] - b.range[0]);

    // Merge overlapping ranges; when overlaps occur, the lowest original pattern
    // index wins so that built-in > global > project and earlier patterns win.
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
    let builtIn = 0;
    let global = 0;
    let project = 0;
    for (const { idx } of merged) {
      if (idx < builtInCount) builtIn++;
      else if (idx < builtInCount + globalCount) global++;
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
    return { text: result, builtIn, global, project };
  }

  /**
   * Redact all matching patterns in text, replacing matches with [REDACTED].
   *
   * Strategy:
   * - "Spanning" patterns (those that can match across whitespace) are applied
   *   to the full text via a multi-range merge to avoid one pattern consuming
   *   another's matches.
   * - "Token" patterns (no whitespace/dot in source) are applied token-by-token
   *   so that greedy `.*`-style patterns in one token don't eat adjacent tokens.
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
