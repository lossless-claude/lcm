#!/usr/bin/env node
// Record what a build is, so a consumer of `dist/` can tell whether it is current.
//
// Two fingerprints, written next to the build:
//
//   <dist>/BUILD_ID      first 16 hex chars of a sha256 over every *.js file under the
//                        directory, walked in sorted relative-path order, hashing the path
//                        alongside the bytes so that a rename changes the id. Because the
//                        file travels with a copy of the build, an installed copy reports
//                        the same id as its source, while any rebuild that changes any
//                        emitted file changes it.
//
//   <dist>/BUILD_SOURCES first 16 hex chars of a sha256 over every file the build reads —
//                        `src/`, `bin/`, `installer/` and `tsconfig.json`, same recipe. A
//                        test suite that runs the built CLI compares this against the
//                        working tree so a stale `dist/` cannot pass silently; the two
//                        ids answer different questions and neither is derivable from the
//                        other without building.
//
// Usage: node scripts/write-build-id.mjs [distDir]   (default: ./dist)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

function collectFiles(dir, root, out, predicate) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, root, out, predicate);
    else if (entry.isFile() && predicate(entry.name)) out.push(relative(root, full));
  }
  return out;
}

function hashPaths(root, paths) {
  const hash = createHash("sha256");
  for (const rel of paths) {
    hash.update(rel.split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

// Everything `npm run build` reads: `tsc` over tsconfig's include, plus the assets and the
// installer script `postbuild` copies into `dist/`.
const SOURCE_DIRS = ["src", "bin", "installer"];
const SOURCE_FILES = ["tsconfig.json"];

/** Fingerprint of the emitted JavaScript: what this build *is*. */
export function computeBuildId(distDir) {
  return hashPaths(distDir, collectFiles(distDir, distDir, [], (name) => name.endsWith(".js")).sort());
}

/** Fingerprint of the inputs: what this build was made *from*. */
export function sourceFingerprint(root) {
  const files = [...SOURCE_FILES];
  for (const dir of SOURCE_DIRS) {
    collectFiles(join(root, dir), root, files, (name) => !name.startsWith("."));
  }
  return hashPaths(root, files.sort());
}

// Importing this file for the two fingerprint functions must write nothing: the test suite
// imports `sourceFingerprint` before every test file, and a side effect there would rewrite
// the very file it is checking.
function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const distDir = process.argv[2] ?? "dist";
  const buildId = computeBuildId(distDir);
  writeFileSync(join(distDir, "BUILD_ID"), buildId);
  writeFileSync(join(distDir, "BUILD_SOURCES"), sourceFingerprint(process.cwd()));
  process.stdout.write(buildId + "\n");
}
