#!/usr/bin/env node
/**
 * Captures golden CLI snapshots for test/bin/golden.test.ts.
 *
 * Writes ONLY missing snapshot files under test/bin/golden/snapshots/ and refuses
 * to overwrite an existing one — snapshots are frozen once captured; regenerating
 * one on purpose means deleting it first.
 *
 * `--verify`: instead of writing into the committed snapshot directory, captures
 * into a scratch temp directory and diffs it against the committed set. Exits
 * non-zero on any difference. Use it to prove normalisation is stable across runs.
 *
 * Usage:
 *   node scripts/golden-capture.mjs           # capture missing snapshots
 *   node scripts/golden-capture.mjs --verify  # capture again and diff vs committed
 */
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "bin", "lcm.js");
const SNAPSHOT_DIR = join(REPO_ROOT, "test", "bin", "golden", "snapshots");
const FIXTURES_DIR = join(REPO_ROOT, "test", "bin", "golden", "fixtures");
const VERIFY = process.argv.includes("--verify");

if (!existsSync(CLI_ENTRY)) {
  console.error(`Missing ${CLI_ENTRY}. Build first: LCM_SKIP_CACHE_SYNC=1 npm run build`);
  process.exit(1);
}

// `test/` is not part of the tsc build (see tsconfig.json), so the case table has no
// dist/ copy. Node's native TypeScript support imports it directly.
const { GOLDEN_CASES } = await import(join(REPO_ROOT, "test", "bin", "golden", "cases.ts"));

const PKG_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version;

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const REPO_ROOTS = [...new Set([REPO_ROOT, safeRealpath(REPO_ROOT)])];

function projectIdFor(cwd) {
  return createHash("sha256").update(safeRealpath(cwd)).digest("hex");
}

function replaceAll(text, needle, token) {
  if (!needle) return text;
  return text.split(needle).join(token);
}

function normalize(text, ctx) {
  let out = text;
  out = out.replace(/^(\s*at .*)$/gm, (line) => line.replace(/([^\s()]+):(\d+):(\d+)/g, "<FRAME>"));
  for (const root of [...ctx.tmpRoots].sort((a, b) => b.length - a.length)) out = replaceAll(out, root, "<TMP>");
  for (const root of [...REPO_ROOTS].sort((a, b) => b.length - a.length)) out = replaceAll(out, root, "<REPO>");
  out = replaceAll(out, PKG_VERSION, "<VERSION>");
  out = replaceAll(out, ctx.projectId, "<PROJECT>");
  out = out.replace(/\(node:\d+\)[^\n]*\n?/g, "<PIDWARN>\n");
  return out;
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "lcm-golden-capture-"));
  for (const sub of ["home", "lcm", "tmp", "project"]) mkdirSync(join(root, sub));
  spawnSync("git", ["init", "-q"], { cwd: join(root, "project") });
  return root;
}

function buildEnv(root) {
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

function runOne(c, root) {
  const cwd = join(root, "project");
  for (const fixture of c.fixtures ?? []) {
    copyFileSync(join(FIXTURES_DIR, fixture.from), join(cwd, fixture.dest));
  }
  const env = buildEnv(root);
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...c.argv], {
    input: c.stdin ?? "",
    timeout: 10000,
    killSignal: "SIGKILL",
    env,
    cwd,
    encoding: "utf8",
  });
  const ctx = { tmpRoots: [root, safeRealpath(root)], projectId: projectIdFor(cwd) };
  return {
    out: normalize(result.stdout ?? "", ctx),
    err: normalize(result.stderr ?? "", ctx),
    code: String(result.status),
  };
}

function snapshotName(c, kind) {
  return c.platform ? `${c.id}.${process.platform}.${kind}` : `${c.id}.${kind}`;
}

// Cases sharing a group run in order against one root; everything else is independent.
function runAll() {
  const results = new Map();
  const groups = new Map();
  const standalone = [];
  for (const c of GOLDEN_CASES) {
    if (c.group) {
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group).push(c);
    } else {
      standalone.push(c);
    }
  }
  for (const c of standalone) {
    const root = makeRoot();
    try {
      results.set(c.id, runOne(c, root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const cases of groups.values()) {
    const root = makeRoot();
    try {
      for (const c of cases) results.set(c.id, runOne(c, root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return results;
}

function writeMissing(results) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  let written = 0;
  for (const c of GOLDEN_CASES) {
    const r = results.get(c.id);
    for (const kind of ["out", "err", "code"]) {
      const path = join(SNAPSHOT_DIR, snapshotName(c, kind));
      if (existsSync(path)) continue;
      writeFileSync(path, r[kind]);
      written++;
    }
  }
  console.log(`Wrote ${written} new snapshot file(s) under ${SNAPSHOT_DIR}`);
}

function verify(results) {
  const scratch = mkdtempSync(join(tmpdir(), "lcm-golden-verify-"));
  try {
    let diffs = 0;
    for (const c of GOLDEN_CASES) {
      const r = results.get(c.id);
      for (const kind of ["out", "err", "code"]) {
        const name = snapshotName(c, kind);
        const committedPath = join(SNAPSHOT_DIR, name);
        if (!existsSync(committedPath)) {
          console.error(`  MISSING committed snapshot: ${name}`);
          diffs++;
          continue;
        }
        const committed = readFileSync(committedPath, "utf8");
        if (committed !== r[kind]) {
          console.error(`  DIFF in ${name}`);
          diffs++;
        }
      }
    }
    if (diffs > 0) {
      console.error(`\nVerify failed: ${diffs} snapshot(s) differ on a second capture.`);
      process.exit(1);
    }
    console.log(`Verify OK: a second capture is byte-identical to the committed ${readdirSync(SNAPSHOT_DIR).length} snapshot file(s).`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const results = runAll();
if (VERIFY) verify(results);
else writeMissing(results);
