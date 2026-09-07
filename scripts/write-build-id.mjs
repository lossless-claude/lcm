#!/usr/bin/env node
// Compute a build fingerprint over the emitted JavaScript and write it to
// <dist>/BUILD_ID (plain text, no trailing newline).
//
// The id is the first 16 hex chars of a sha256 over every *.js file under the
// directory, walked in sorted relative-path order, hashing the path alongside
// the bytes so that a rename changes the id. Because the file travels with a
// copy of the build, an installed copy reports the same id as its source,
// while any rebuild that changes any emitted file changes it.
//
// Usage: node scripts/write-build-id.mjs [distDir]   (default: ./dist)

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

function collectJsFiles(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, root, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(relative(root, full));
  }
  return out;
}

function computeBuildId(distDir) {
  const files = collectJsFiles(distDir, distDir, []).sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel.split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(join(distDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

const distDir = process.argv[2] ?? "dist";
const buildId = computeBuildId(distDir);
writeFileSync(join(distDir, "BUILD_ID"), buildId);
process.stdout.write(buildId + "\n");
