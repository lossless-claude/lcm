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
  /**
   * Relative paths under the isolated temp root the run is allowed to newly create.
   * Parent directories created along the way are permitted automatically — only the
   * leaf paths need declaring. One-directional: this never permits a removal.
   */
  creates: string[];
  /**
   * Relative paths that must exist before the run and be gone after. Unlike `creates`,
   * this has no automatic ancestor allowance — a directory that also disappears needs
   * its own entry.
   */
  removes: string[];
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
  { id: "r01", argv: [], creates: [], removes: [] },
  { id: "r02", argv: ["--help"], creates: [], removes: [] },
  { id: "r03", argv: ["-h"], creates: [], removes: [] },
  { id: "r04", argv: ["--version"], creates: [], removes: [] },
  { id: "r05", argv: ["help"], creates: [], removes: [] },
  { id: "r06", argv: ["help", "status"], creates: [], removes: [] },
  { id: "r07", argv: ["help", "connectors"], creates: [], removes: [] },
  { id: "r08", argv: ["help", "nope"], creates: [], removes: [] },
  { id: "r09", argv: ["nope"], creates: [], removes: [] },
  { id: "r10", argv: ["--bogus"], creates: [], removes: [] },
  { id: "r11", argv: ["status", "--help", "extra"], creates: [], removes: [] },
  { id: "r12", argv: ["--help", "status"], creates: [], removes: [] },

  // ─── memory ────────────────────────────────────────────────────────────────
  { id: "m01", argv: ["search"], creates: [], removes: [] },
  { id: "m02", argv: ["search", "-h"], creates: [], removes: [] },
  { id: "m03", argv: ["search", "--help"], creates: [], removes: [] },
  { id: "m06", argv: ["search", "q", "--layer", "bogus"], creates: [], removes: [] },
  { id: "m07", argv: ["grep"], creates: [], removes: [] },
  { id: "m08", argv: ["grep", "-h"], creates: [], removes: [] },
  { id: "m09", argv: ["grep", "q", "--mode", "bogus"], creates: [], removes: [] },
  { id: "m10", argv: ["grep", "q", "--scope", "bogus"], creates: [], removes: [] },
  { id: "m11", argv: ["describe"], creates: [], removes: [] },
  { id: "m12", argv: ["describe", "-h"], creates: [], removes: [] },
  { id: "m13", argv: ["expand"], creates: [], removes: [] },
  { id: "m15", argv: ["store"], creates: [], removes: [] },
  { id: "m16", argv: ["store", "-h"], creates: [], removes: [] },
  { id: "m17", argv: ["search", "--limit", "3"], creates: [], removes: [] },
  { id: "m18", argv: ["search", "q", "-h"], creates: [], removes: [] },
  { id: "m19", argv: ["grep", "q", "-h"], creates: [], removes: [] },
  { id: "m20", argv: ["describe", "x", "-h"], creates: [], removes: [] },
  { id: "m21", argv: ["expand", "x", "--depth", "abc", "-h"], creates: [], removes: [] },
  { id: "m22", argv: ["store", "text", "--tag", "one", "--tag", "two", "-h"], creates: [], removes: [] },
  { id: "m23", argv: ["search", "q", "--layer", "episodic", "--layer", "bogus", "--layer", "bogus"], creates: [], removes: [] },

  // ─── bench ─────────────────────────────────────────────────────────────────
  { id: "b01", argv: ["bench"], creates: [], removes: [] },
  { id: "b02", argv: ["bench", "--help"], creates: [], removes: [] },
  { id: "b03", argv: ["bench", "build", "--help"], creates: [], removes: [] },
  { id: "b04", argv: ["bench", "build", "--generator", "invalid"], creates: [], removes: [] },
  { id: "b05", argv: ["bench", "build", "--n", "abc"], creates: [], removes: [] },
  { id: "b06", argv: ["bench", "run", "--help"], creates: [], removes: [] },
  { id: "b07", argv: ["bench", "run", "--k", "abc"], creates: [], removes: [] },
  { id: "b08", argv: ["bench", "run", "--bogus"], creates: [], removes: [] },

  // ─── daemon ────────────────────────────────────────────────────────────────
  { id: "d01", argv: ["daemon"], creates: [], removes: [] },
  { id: "d02", argv: ["daemon", "-h"], creates: [], removes: [] },
  { id: "d03", argv: ["daemon", "--help"], creates: [], removes: [] },
  { id: "d04", argv: ["daemon", "start", "-h"], creates: [], removes: [] },
  { id: "d05", argv: ["daemon", "stop", "-h"], creates: [], removes: [] },
  { id: "d06", argv: ["daemon", "restart", "-h"], creates: [], removes: [] },
  { id: "d07", argv: ["daemon", "bogus"], creates: [], removes: [] },
  { id: "d08", argv: ["daemon", "stop", "--minutes", "abc"], creates: [], removes: [] },
  { id: "d09", argv: ["daemon", "stop", "--reason"], creates: [], removes: [] },
  { id: "d10", argv: ["daemon", "--detach", "start"], creates: [], removes: [] },
  { id: "d11", argv: ["daemon", "--help", "stop"], creates: [], removes: [] },

  // ─── compact ───────────────────────────────────────────────────────────────
  { id: "c01", argv: ["compact", "-h"], creates: [], removes: [] },
  { id: "c02", argv: ["compact", "--help"], creates: [], removes: [] },
  { id: "c03", argv: ["compact", "--bogus"], creates: [], removes: [] },
  { id: "c04", argv: ["compact", "--no-promote", "-h"], creates: [], removes: [] },

  // ─── hook commands ─────────────────────────────────────────────────────────
  { id: "h01", argv: ["codex-hook", "-h"], creates: [], removes: [] },
  { id: "h02", argv: ["codex-hook"], stdin: "", creates: [], removes: [] },
  { id: "h03", argv: ["codex-hook"], stdin: "{}", creates: [], removes: [] },
  { id: "h04", argv: ["codex-hook"], stdin: "not json", creates: [], removes: [] },
  { id: "h05", argv: ["restore", "-h"], creates: [], removes: [] },
  { id: "h07", argv: ["session-end", "-h"], creates: [], removes: [] },
  { id: "h09", argv: ["user-prompt", "-h"], creates: [], removes: [] },
  { id: "h11", argv: ["post-tool", "-h"], creates: [], removes: [] },
  { id: "h12", argv: ["post-tool"], stdin: "{}", creates: [], removes: [] },
  { id: "h13", argv: ["session-snapshot", "-h"], creates: [], removes: [] },
  { id: "h14", argv: ["session-snapshot"], stdin: "", creates: [], removes: [] },

  // ─── mcp / install / uninstall ─────────────────────────────────────────────
  { id: "i01", argv: ["mcp", "-h"], creates: [], removes: [] },
  { id: "i02", argv: ["mcp", "--help"], creates: [], removes: [] },
  { id: "i03", argv: ["install", "-h"], creates: [], removes: [] },
  { id: "i04", argv: ["install", "--dry-run"], creates: [], removes: [] },
  { id: "i05", argv: ["uninstall", "-h"], creates: [], removes: [] },
  { id: "i06", argv: ["uninstall", "--dry-run"], creates: [], removes: [], platform: true },
  { id: "i07", argv: ["install", "--bogus"], creates: [], removes: [] },

  // ─── diagnostics ───────────────────────────────────────────────────────────
  { id: "g01", argv: ["status", "-h"], creates: [], removes: [] },
  { id: "g04", argv: ["stats", "-h"], creates: [], removes: [] },
  { id: "g05", argv: ["stats", "--pool", "-h"], creates: [], removes: [] },
  { id: "g06", argv: ["doctor", "-h"], creates: [], removes: [] },
  { id: "g08", argv: ["diagnose", "-h"], creates: [], removes: [] },
  { id: "g09", argv: ["diagnose", "--days", "abc"], creates: [], removes: [] },
  { id: "g10", argv: ["diagnose", "--bogus"], creates: [], removes: [] },

  // ─── connectors ────────────────────────────────────────────────────────────
  { id: "n01", argv: ["connectors"], creates: [], removes: [] },
  { id: "n02", argv: ["connectors", "-h"], creates: [], removes: [] },
  { id: "n03", argv: ["connectors", "list"], creates: [], removes: [] },
  { id: "n04", argv: ["connectors", "list", "--format", "xml"], creates: [], removes: [] },
  { id: "n05", argv: ["connectors", "list", "--global"], creates: [], removes: [] },
  { id: "n06", argv: ["connectors", "install"], creates: [], removes: [] },
  { id: "n07", argv: ["connectors", "install", "bogus"], creates: [], removes: [] },
  { id: "n08", argv: ["connectors", "install", "codex", "--type", "bogus"], creates: [], removes: [] },
  {
    id: "n09",
    argv: ["connectors", "install", "codex", "--type", "skill"],
    creates: ["project/.agents/skills/lcm-memory/SKILL.md"],
    removes: [],
    group: "n09-n12",
  },
  { id: "n10", argv: ["connectors", "doctor", "codex"], creates: [], removes: [], group: "n09-n12" },
  {
    id: "n11",
    argv: ["connectors", "remove", "codex", "--type", "skill"],
    creates: [],
    removes: ["project/.agents/skills/lcm-memory/SKILL.md"],
    group: "n09-n12",
  },
  { id: "n12", argv: ["connectors", "doctor", "codex"], creates: [], removes: [], group: "n09-n12" },
  { id: "n13", argv: ["connectors", "doctor", "bogus"], creates: [], removes: [] },
  { id: "n14", argv: ["connectors", "remove"], creates: [], removes: [] },
  { id: "n15", argv: ["connectors", "--global", "list"], creates: [], removes: [] },
  { id: "n16", argv: ["connectors", "install", "codex", "--help"], creates: [], removes: [] },
  { id: "n17", argv: ["connectors", "--help", "remove", "codex"], creates: [], removes: [] },

  // ─── sensitive ─────────────────────────────────────────────────────────────
  { id: "s01", argv: ["sensitive"], creates: [], removes: [] },
  { id: "s02", argv: ["sensitive", "-h"], creates: [], removes: [] },
  { id: "s03", argv: ["sensitive", "list"], creates: [], removes: [] },
  { id: "s04", argv: ["sensitive", "bogus"], creates: [], removes: [] },
  { id: "s05", argv: ["sensitive", "test", "AKIAIOSFODNN7EXAMPLE"], creates: [], removes: [] },
  { id: "s06", argv: ["sensitive", "--bogus"], creates: [], removes: [] },

  // ─── import / promote / export / import-knowledge ─────────────────────────
  { id: "k01", argv: ["import", "-h"], creates: [], removes: [] },
  { id: "k02", argv: ["import", "--provider", "bogus"], creates: [], removes: [] },
  { id: "k03", argv: ["import", "--dry-run"], creates: [], removes: [] },
  { id: "k04", argv: ["import", "--bogus"], creates: [], removes: [] },
  { id: "k05", argv: ["promote", "-h"], creates: [], removes: [] },

  { id: "k07", argv: ["export", "-h"], creates: [], removes: [] },
  { id: "k08", argv: ["export", "--format", "xml"], creates: [], removes: [] },
  { id: "k09", argv: ["export"], creates: [], removes: [] },
  { id: "k10", argv: ["export", "--output", "out.json"], creates: [], removes: [] },

  { id: "k11", argv: ["import-knowledge"], creates: [], removes: [] },
  { id: "k12", argv: ["import-knowledge", "-h"], creates: [], removes: [] },
  { id: "k13", argv: ["import-knowledge", "missing.json"], creates: [], removes: [] },
  { id: "k14", argv: ["import-knowledge", "fixture.json", "--confidence", "2"], creates: [], removes: [] },
  {
    id: "k15",
    argv: ["import-knowledge", "fixture.json", "--dry-run"],
    creates: [], removes: [],
    fixtures: [KNOWLEDGE_FIXTURE],
  },
  { id: "k16", argv: ["import-knowledge", "fixture.json", "--help"], creates: [], removes: [] },
  { id: "k17", argv: ["import", "--codex", "--provider", "claude", "--dry-run"], creates: [], removes: [] },
];

export const GOLDEN_CASE_IDS = GOLDEN_CASES.map((c) => c.id);
