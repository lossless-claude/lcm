#!/usr/bin/env node
// Writes package.json's version into the two other manifests that
// check-manifest.mjs's version-parity rule reads: .claude-plugin/plugin.json
// and .claude-plugin/marketplace.json (every plugin entry's version). Reads and
// writes the same paths that rule reads, so syncing and checking never drift apart.
//
// A marketplace entry also carries the selector its host installs from, and that
// selector names the release: a github source gets `ref: v<version>` (the tag
// publish.yml creates for that commit), an npm source gets the exact version.
// Without the pin, a fresh install would fetch the default branch's HEAD under
// the released version's label.
//
// Called from "version-packages" (changeset version && node
// scripts/sync-versions.mjs), so it runs right after changesets bumps
// package.json.
//
// Preserves each file's existing indentation and trailing newline instead of
// imposing a fixed style, so a version-only change stays a version-only diff.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function detectIndent(raw) {
  const match = raw.match(/^[ \t]+/m);
  return match ? match[0] : "  ";
}

function writeJsonPreservingStyle(path, mutate) {
  const raw = readFileSync(path, "utf8");
  const indent = detectIndent(raw);
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  const manifest = JSON.parse(raw);
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, indent) + trailingNewline);
}

function syncVersions(root, version) {
  const pluginPath = join(root, ".claude-plugin", "plugin.json");
  const marketplacePath = join(root, ".claude-plugin", "marketplace.json");

  writeJsonPreservingStyle(pluginPath, (manifest) => {
    manifest.version = version;
  });

  writeJsonPreservingStyle(marketplacePath, (manifest) => {
    if (!manifest.plugins?.[0]) {
      throw new Error(`${marketplacePath} has no plugins[0] to write a version onto.`);
    }
    for (const entry of manifest.plugins) {
      entry.version = version;
      if (entry.source?.source === "github") entry.source.ref = `v${version}`;
      if (entry.source?.source === "npm") entry.source.version = version;
    }
  });

  return { pluginPath, marketplacePath };
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const root = process.argv[2] ?? process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const { pluginPath, marketplacePath } = syncVersions(root, pkg.version);
  console.log(`sync-versions: set ${pluginPath} and ${marketplacePath} to ${pkg.version}`);
}

export { syncVersions };
