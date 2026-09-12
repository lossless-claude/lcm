/**
 * Golden CLI cases: the frozen argv/stdin table for `test/bin/golden.test.ts`.
 *
 * Source of truth for which ids exist and why: `plans/refactor-bin-lcm/golden-cases.md`
 * (repo-local planning doc, not part of the plugin). This file is the executable
 * encoding of that spec — every kept id from the spec's lists appears here with an
 * argv array (never a shell string) and, where the spec calls for one, stdin,
 * fixtures to stage, a platform key, or a shared group.
 */

export interface GoldenFixture {
  /** Path to stage the fixture at, relative to the case's cwd. */
  dest: string;
  /** Source file, relative to `test/bin/golden/fixtures/`. */
  from: string;
}

export interface GoldenCase {
  id: string;
  argv: string[];
  /** Stdin fed to the process; ended explicitly. Empty when omitted. */
  stdin?: string;
  /** Relative paths under the isolated temp root allowed to change (create/remove/modify). */
  writes: string[];
  /**
   * True when this case's output differs by `process.platform` and its snapshots are
   * keyed by the platform that captured them (`<id>.<platform>.out` etc). The harness
   * looks up the file for the platform it is currently running on and skips the case,
   * naming the missing file, when that platform was never captured.
   */
  platform?: boolean;
  /** Cases sharing a group run in file order against one shared temp root. */
  group?: string;
  fixtures?: GoldenFixture[];
}

const KNOWLEDGE_FIXTURE: GoldenFixture = { dest: "fixture.json", from: "knowledge.json" };

export const GOLDEN_CASES: GoldenCase[] = [
  // ─── root ──────────────────────────────────────────────────────────────────
  { id: "r01", argv: [], writes: [] },
  { id: "r02", argv: ["--help"], writes: [] },
  { id: "r03", argv: ["-h"], writes: [] },
  { id: "r04", argv: ["--version"], writes: [] },
  { id: "r05", argv: ["help"], writes: [] },
  { id: "r06", argv: ["help", "status"], writes: [] },
  { id: "r07", argv: ["help", "connectors"], writes: [] },
  { id: "r08", argv: ["help", "nope"], writes: [] },
  { id: "r09", argv: ["nope"], writes: [] },
  { id: "r10", argv: ["--bogus"], writes: [] },
  { id: "r11", argv: ["status", "--help", "extra"], writes: [] },
  { id: "r12", argv: ["--help", "status"], writes: [] },

  // ─── memory ────────────────────────────────────────────────────────────────
  { id: "m01", argv: ["search"], writes: [] },
  { id: "m02", argv: ["search", "-h"], writes: [] },
  { id: "m03", argv: ["search", "--help"], writes: [] },
  { id: "m06", argv: ["search", "q", "--layer", "bogus"], writes: [] },
  { id: "m07", argv: ["grep"], writes: [] },
  { id: "m08", argv: ["grep", "-h"], writes: [] },
  { id: "m09", argv: ["grep", "q", "--mode", "bogus"], writes: [] },
  { id: "m10", argv: ["grep", "q", "--scope", "bogus"], writes: [] },
  { id: "m11", argv: ["describe"], writes: [] },
  { id: "m12", argv: ["describe", "-h"], writes: [] },
  { id: "m13", argv: ["expand"], writes: [] },
  { id: "m15", argv: ["store"], writes: [] },
  { id: "m16", argv: ["store", "-h"], writes: [] },
  { id: "m17", argv: ["search", "--limit", "3"], writes: [] },
  { id: "m18", argv: ["search", "q", "-h"], writes: [] },
  { id: "m19", argv: ["grep", "q", "-h"], writes: [] },
  { id: "m20", argv: ["describe", "x", "-h"], writes: [] },
  { id: "m21", argv: ["expand", "x", "--depth", "abc", "-h"], writes: [] },
  { id: "m22", argv: ["store", "text", "--tag", "one", "--tag", "two", "-h"], writes: [] },
  { id: "m23", argv: ["search", "q", "--layer", "episodic", "--layer", "bogus", "--layer", "bogus"], writes: [] },

  // ─── bench ─────────────────────────────────────────────────────────────────
  { id: "b01", argv: ["bench"], writes: [] },
  { id: "b02", argv: ["bench", "--help"], writes: [] },
  { id: "b03", argv: ["bench", "build", "--help"], writes: [] },
  { id: "b04", argv: ["bench", "build", "--generator", "invalid"], writes: [] },
  { id: "b05", argv: ["bench", "build", "--n", "abc"], writes: [] },
  { id: "b06", argv: ["bench", "run", "--help"], writes: [] },
  { id: "b07", argv: ["bench", "run", "--k", "abc"], writes: [] },
  { id: "b08", argv: ["bench", "run", "--bogus"], writes: [] },

  // ─── daemon ────────────────────────────────────────────────────────────────
  { id: "d01", argv: ["daemon"], writes: [] },
  { id: "d02", argv: ["daemon", "-h"], writes: [] },
  { id: "d03", argv: ["daemon", "--help"], writes: [] },
  { id: "d04", argv: ["daemon", "start", "-h"], writes: [] },
  { id: "d05", argv: ["daemon", "stop", "-h"], writes: [] },
  { id: "d06", argv: ["daemon", "restart", "-h"], writes: [] },
  { id: "d07", argv: ["daemon", "bogus"], writes: [] },
  { id: "d08", argv: ["daemon", "stop", "--minutes", "abc"], writes: [] },
  { id: "d09", argv: ["daemon", "stop", "--reason"], writes: [] },
  { id: "d10", argv: ["daemon", "--detach", "start"], writes: [] },
  { id: "d11", argv: ["daemon", "--help", "stop"], writes: [] },

  // ─── compact ───────────────────────────────────────────────────────────────
  { id: "c01", argv: ["compact", "-h"], writes: [] },
  { id: "c02", argv: ["compact", "--help"], writes: [] },
  { id: "c03", argv: ["compact", "--bogus"], writes: [] },
  { id: "c04", argv: ["compact", "--no-promote", "-h"], writes: [] },

  // ─── hook commands ─────────────────────────────────────────────────────────
  { id: "h01", argv: ["codex-hook", "-h"], writes: [] },
  { id: "h02", argv: ["codex-hook"], stdin: "", writes: [] },
  { id: "h03", argv: ["codex-hook"], stdin: "{}", writes: [] },
  { id: "h04", argv: ["codex-hook"], stdin: "not json", writes: [] },
  { id: "h05", argv: ["restore", "-h"], writes: [] },
  { id: "h07", argv: ["session-end", "-h"], writes: [] },
  { id: "h09", argv: ["user-prompt", "-h"], writes: [] },
  { id: "h11", argv: ["post-tool", "-h"], writes: [] },
  { id: "h12", argv: ["post-tool"], stdin: "{}", writes: [] },
  { id: "h13", argv: ["session-snapshot", "-h"], writes: [] },
  { id: "h14", argv: ["session-snapshot"], stdin: "", writes: [] },

  // ─── mcp / install / uninstall ─────────────────────────────────────────────
  { id: "i01", argv: ["mcp", "-h"], writes: [] },
  { id: "i02", argv: ["mcp", "--help"], writes: [] },
  { id: "i03", argv: ["install", "-h"], writes: [] },
  { id: "i04", argv: ["install", "--dry-run"], writes: [] },
  { id: "i05", argv: ["uninstall", "-h"], writes: [] },
  { id: "i06", argv: ["uninstall", "--dry-run"], writes: [], platform: true },
  { id: "i07", argv: ["install", "--bogus"], writes: [] },

  // ─── diagnostics ───────────────────────────────────────────────────────────
  { id: "g01", argv: ["status", "-h"], writes: [] },
  { id: "g04", argv: ["stats", "-h"], writes: [] },
  { id: "g05", argv: ["stats", "--pool", "-h"], writes: [] },
  { id: "g06", argv: ["doctor", "-h"], writes: [] },
  { id: "g08", argv: ["diagnose", "-h"], writes: [] },
  { id: "g09", argv: ["diagnose", "--days", "abc"], writes: [] },
  { id: "g10", argv: ["diagnose", "--bogus"], writes: [] },

  // ─── connectors ────────────────────────────────────────────────────────────
  { id: "n01", argv: ["connectors"], writes: [] },
  { id: "n02", argv: ["connectors", "-h"], writes: [] },
  { id: "n03", argv: ["connectors", "list"], writes: [] },
  { id: "n04", argv: ["connectors", "list", "--format", "xml"], writes: [] },
  { id: "n05", argv: ["connectors", "list", "--global"], writes: [] },
  { id: "n06", argv: ["connectors", "install"], writes: [] },
  { id: "n07", argv: ["connectors", "install", "bogus"], writes: [] },
  { id: "n08", argv: ["connectors", "install", "codex", "--type", "bogus"], writes: [] },
  {
    id: "n09",
    argv: ["connectors", "install", "codex", "--type", "skill"],
    writes: ["project/.agents/skills/lcm-memory/SKILL.md"],
    group: "n09-n12",
  },
  { id: "n10", argv: ["connectors", "doctor", "codex"], writes: [], group: "n09-n12" },
  {
    id: "n11",
    argv: ["connectors", "remove", "codex", "--type", "skill"],
    writes: ["project/.agents/skills/lcm-memory/SKILL.md"],
    group: "n09-n12",
  },
  { id: "n12", argv: ["connectors", "doctor", "codex"], writes: [], group: "n09-n12" },
  { id: "n13", argv: ["connectors", "doctor", "bogus"], writes: [] },
  { id: "n14", argv: ["connectors", "remove"], writes: [] },
  { id: "n15", argv: ["connectors", "--global", "list"], writes: [] },
  { id: "n16", argv: ["connectors", "install", "codex", "--help"], writes: [] },
  { id: "n17", argv: ["connectors", "--help", "remove", "codex"], writes: [] },

  // ─── sensitive ─────────────────────────────────────────────────────────────
  { id: "s01", argv: ["sensitive"], writes: [] },
  { id: "s02", argv: ["sensitive", "-h"], writes: [] },
  { id: "s03", argv: ["sensitive", "list"], writes: [] },
  { id: "s04", argv: ["sensitive", "bogus"], writes: [] },
  { id: "s05", argv: ["sensitive", "test", "AKIAIOSFODNN7EXAMPLE"], writes: [] },
  { id: "s06", argv: ["sensitive", "--bogus"], writes: [] },

  // ─── import / promote / export / import-knowledge ─────────────────────────
  { id: "k01", argv: ["import", "-h"], writes: [] },
  { id: "k02", argv: ["import", "--provider", "bogus"], writes: [] },
  { id: "k03", argv: ["import", "--dry-run"], writes: [] },
  { id: "k04", argv: ["import", "--bogus"], writes: [] },
  { id: "k05", argv: ["promote", "-h"], writes: [] },

  { id: "k07", argv: ["export", "-h"], writes: [] },
  { id: "k08", argv: ["export", "--format", "xml"], writes: [] },
  { id: "k09", argv: ["export"], writes: [] },
  { id: "k10", argv: ["export", "--output", "out.json"], writes: [] },

  { id: "k11", argv: ["import-knowledge"], writes: [] },
  { id: "k12", argv: ["import-knowledge", "-h"], writes: [] },
  { id: "k13", argv: ["import-knowledge", "missing.json"], writes: [] },
  { id: "k14", argv: ["import-knowledge", "fixture.json", "--confidence", "2"], writes: [] },
  {
    id: "k15",
    argv: ["import-knowledge", "fixture.json", "--dry-run"],
    writes: [],
    fixtures: [KNOWLEDGE_FIXTURE],
  },
  { id: "k16", argv: ["import-knowledge", "fixture.json", "--help"], writes: [] },
  { id: "k17", argv: ["import", "--codex", "--provider", "claude", "--dry-run"], writes: [] },
];

export const GOLDEN_CASE_IDS = GOLDEN_CASES.map((c) => c.id);
