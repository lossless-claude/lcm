/**
 * Golden CLI guard: freezes stdout, stderr and exit code for every argv the CLI
 * is meant to keep stable across the bin/lcm.ts command-registration refactor.
 *
 * Case table: ./golden/cases.ts (spec: plans/refactor-bin-lcm/golden-cases.md).
 * Snapshots: ./golden/snapshots/<id>.{out,err,code} (platform-keyed cases add
 * `.<platform>` before the suffix). Snapshots are captured once, by hand, with
 * `scripts/golden-capture.mjs` — this file never writes them.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_CASES, type GoldenCase } from "./golden/cases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const CLI_ENTRY = join(REPO_ROOT, "dist", "bin", "lcm.js");
export const SNAPSHOT_DIR = join(__dirname, "golden", "snapshots");
export const FIXTURES_DIR = join(__dirname, "golden", "fixtures");

if (!existsSync(CLI_ENTRY)) {
  throw new Error(
    `Golden guard precondition failed: ${CLI_ENTRY} is missing.\n` +
      "Build the CLI first: LCM_SKIP_CACHE_SYNC=1 npm run build",
  );
}

const PKG_VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version;

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

const REPO_ROOTS = [...new Set([REPO_ROOT, safeRealpath(REPO_ROOT)])];

export function projectIdFor(cwd: string): string {
  return createHash("sha256").update(safeRealpath(cwd)).digest("hex");
}

/** Replace every occurrence of `needle` in `text`, longest needles first to avoid partial shadowing. */
function replaceAll(text: string, needle: string, token: string): string {
  if (!needle) return text;
  return text.split(needle).join(token);
}

export interface NormalizeContext {
  tmpRoots: string[];
  projectId: string;
}

/**
 * Normalises everything the spec calls machine- or run-specific, and nothing else:
 * ordering, dates and all other content stay exactly as produced.
 */
export function normalize(text: string, ctx: NormalizeContext): string {
  let out = text;

  // Stack-frame locations inside "at ..." lines -> <FRAME>, before any root
  // substitution so a repo- or tmp-rooted frame doesn't get partially rewritten.
  out = out.replace(/^(\s*at .*)$/gm, (line) =>
    line.replace(/([^\s()]+):(\d+):(\d+)/g, "<FRAME>"),
  );

  // Temp root and its realpath alias (macOS /tmp -> /private/tmp), longest first.
  for (const root of [...ctx.tmpRoots].sort((a, b) => b.length - a.length)) {
    out = replaceAll(out, root, "<TMP>");
  }

  // Repository root outside stack frames (already scrubbed above).
  for (const root of [...REPO_ROOTS].sort((a, b) => b.length - a.length)) {
    out = replaceAll(out, root, "<REPO>");
  }

  // Package version.
  out = replaceAll(out, PKG_VERSION, "<VERSION>");

  // Project id (sha256 of the realpath of cwd).
  out = replaceAll(out, ctx.projectId, "<PROJECT>");

  // Node runtime warnings carrying a PID, e.g. "(node:12345) ExperimentalWarning: ...".
  out = out.replace(/\(node:\d+\)[^\n]*\n?/g, "<PIDWARN>\n");

  return out;
}

// ─── temp root / env plumbing ────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-golden-"));
  for (const sub of ["home", "lcm", "tmp", "project"]) mkdirSync(join(root, sub));
  spawnSync("git", ["init", "-q"], { cwd: join(root, "project") });
  return root;
}

function buildEnv(root: string): NodeJS.ProcessEnv {
  const scratchDir = join(root, "tmp");
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    LCM_HOME: join(root, "lcm"),
    TMPDIR: scratchDir,
    TMP: scratchDir,
    TEMP: scratchDir,
    NO_COLOR: "1",
  };
}

// ─── filesystem delta guard ───────────────────────────────────────────────────

/** relative path -> content hash (files/symlinks/other); directories are not recorded. */
function listing(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile()) {
        try {
          out.set(relPath, createHash("sha256").update(readFileSync(abs)).digest("hex"));
        } catch {
          out.set(relPath, "unreadable");
        }
      } else {
        out.set(relPath, `other:${entry.name}`);
      }
    }
  };
  walk(root, "");
  return out;
}

function diffListings(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

const FORBIDDEN_BASENAME = /^daemon\.token$|\.(pid|log|sock)$/;

function assertNoForbiddenFiles(after: Map<string, string>, caseId: string): void {
  for (const path of after.keys()) {
    const base = path.split("/").pop() ?? path;
    if (FORBIDDEN_BASENAME.test(base)) {
      throw new Error(`case ${caseId}: forbidden file present after run: ${path}`);
    }
  }
}

// ─── snapshot comparison ──────────────────────────────────────────────────────

function unifiedDiff(expected: string, actual: string): string {
  const expLines = expected.split("\n");
  const actLines = actual.split("\n");
  const max = Math.max(expLines.length, actLines.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const e = expLines[i];
    const a = actLines[i];
    if (e === a) continue;
    if (e !== undefined) lines.push(`- ${e}`);
    if (a !== undefined) lines.push(`+ ${a}`);
  }
  return lines.join("\n");
}

function snapshotPath(c: GoldenCase, kind: "out" | "err" | "code"): string {
  const name = c.platform ? `${c.id}.${process.platform}.${kind}` : `${c.id}.${kind}`;
  return join(SNAPSHOT_DIR, name);
}

function compareSnapshot(c: GoldenCase, kind: "out" | "err" | "code", actual: string): void {
  const path = snapshotPath(c, kind);
  const expected = readFileSync(path, "utf8");
  if (actual !== expected) {
    throw new Error(`case ${c.id}: ${kind} mismatch vs ${path}\n${unifiedDiff(expected, actual)}`);
  }
}

// ─── one case, against an already-prepared root ──────────────────────────────

function runCase(c: GoldenCase, root: string): void {
  const cwd = join(root, "project");
  for (const fixture of c.fixtures ?? []) {
    copyFileSync(join(FIXTURES_DIR, fixture.from), join(cwd, fixture.dest));
  }

  const env = buildEnv(root);
  const before = listing(root);

  const result = spawnSync(process.execPath, [CLI_ENTRY, ...c.argv], {
    input: c.stdin ?? "",
    timeout: 10000,
    killSignal: "SIGKILL",
    env,
    cwd,
    encoding: "utf8",
  });

  if (result.signal || result.error) {
    throw new Error(
      `case ${c.id}: process did not complete cleanly (signal=${result.signal ?? "none"}, error=${result.error ?? "none"})`,
    );
  }

  const ctx: NormalizeContext = {
    tmpRoots: [root, safeRealpath(root)],
    projectId: projectIdFor(cwd),
  };

  compareSnapshot(c, "out", normalize(result.stdout ?? "", ctx));
  compareSnapshot(c, "err", normalize(result.stderr ?? "", ctx));
  compareSnapshot(c, "code", String(result.status));

  const after = listing(root);
  assertNoForbiddenFiles(after, c.id);

  const delta = diffListings(before, after);
  const expected = new Set(c.writes);
  const unexpected = delta.filter((p) => !expected.has(p));
  expect(unexpected, `case ${c.id}: unexpected filesystem changes`).toEqual([]);
  const missing = c.writes.filter((p) => !delta.includes(p));
  expect(missing, `case ${c.id}: expected writes did not happen`).toEqual([]);

  if (c.id === "k10") {
    expect(after.has("out.json"), "case k10: out.json must not be created").toBe(false);
  }
}

// ─── registration ─────────────────────────────────────────────────────────────

const standalone: GoldenCase[] = [];
const groups = new Map<string, GoldenCase[]>();
for (const c of GOLDEN_CASES) {
  if (c.group) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  } else {
    standalone.push(c);
  }
}

describe("golden CLI guard", () => {
  for (const c of standalone) {
    if (c.platform && !existsSync(snapshotPath(c, "out"))) {
      it.skip(`${c.id} (skipped: missing ${snapshotPath(c, "out")})`, () => {});
      continue;
    }

    it(c.id, () => {
      const root = makeRoot();
      try {
        runCase(c, root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const [groupName, cases] of groups) {
    const missing = cases.filter((c) => c.platform && !existsSync(snapshotPath(c, "out")));
    if (missing.length > 0) {
      it.skip(
        `group ${groupName} (skipped: missing ${missing.map((c) => snapshotPath(c, "out")).join(", ")})`,
        () => {},
      );
      continue;
    }

    it(`group ${groupName}`, () => {
      const root = makeRoot();
      try {
        for (const c of cases) runCase(c, root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
