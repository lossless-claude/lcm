#!/usr/bin/env node
// Verifies the published artifact matches the manifest that describes it.
//
// Two independent checks, both born from the same defect: a manifest that
// claims something the artifact does not do.
//
//   (a) every external import in dist/ is declared somewhere the installer
//       will actually install it from — dependencies, peerDependencies, or
//       optionalDependencies. devDependencies do not ship, so they do not
//       count. peerDependencies must be included: dist/src/llm/anthropic.js
//       and dist/src/llm/openai.js import "@anthropic-ai/sdk" and "openai",
//       both declared only as peers.
//   (b) package.json, .claude-plugin/plugin.json and
//       .claude-plugin/marketplace.json (plugins[0].version) all name the
//       same version. Nothing else keeps them in step.
//
// An empty dist/ or a scan that finds zero files or zero imports is treated
// as a failure, not a pass — that is the exact shape of the bug this script
// exists to catch (a build that silently produced nothing to check).
//
// Usage: node scripts/check-manifest.mjs [root]
//   exported: checkManifest(root) -> Finding[]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { builtinModules } from "node:module";

const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);

// import ... from "x" | export ... from "x" | import("x") | require("x")
const IMPORT_RE = /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function extname(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i);
}

function collectCodeFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectCodeFiles(full, out);
    else if (CODE_EXT.has(extname(entry.name))) out.push(full);
  }
  return out;
}

function isExternalSpecifier(spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.includes(":")) return false; // node:*, file:, http(s):, etc.
  return true;
}

function packageNameFor(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function extractImports(source) {
  const specs = new Set();
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source))) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specs.add(spec);
  }
  return specs;
}

function recordImport(imports, pkgName, filePath) {
  if (!imports.has(pkgName)) imports.set(pkgName, new Set());
  imports.get(pkgName).add(filePath);
}

/** Map of external package name -> Set of dist-relative file paths importing it. */
function collectExternalImports(files, root) {
  const imports = new Map();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const spec of extractImports(source)) {
      if (!isExternalSpecifier(spec) || builtinModules.includes(spec)) continue;
      recordImport(imports, packageNameFor(spec), relative(root, file));
    }
  }
  return imports;
}

function declaredPackages(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
}

function checkDeclaredImports(root, pkg) {
  const distDir = join(root, "dist");

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return [`dist/ does not exist at ${distDir}. Run "npm run build" before check-manifest — an empty dist means every import check trivially passes, which is the failure mode this script exists to catch.`];
  }

  const files = collectCodeFiles(distDir);
  if (files.length === 0) {
    return [`dist/ contains no .js/.mjs/.cjs files. A build that produces zero code files must not be treated as a passing check. Run "npm run build" and verify it emits JavaScript.`];
  }

  const imports = collectExternalImports(files, root);
  if (imports.size === 0) {
    return [`Scanned ${files.length} file(s) under dist/ and found zero external imports. That is almost certainly a bug in the scan (or a dist/ that was never actually exercised), not evidence the build has no dependencies — fix the scan before trusting a pass here.`];
  }

  const declared = declaredPackages(pkg);
  const findings = [];
  for (const [pkgName, importingFiles] of imports) {
    if (declared.has(pkgName)) continue;
    const example = [...importingFiles][0];
    findings.push(`"${pkgName}" is imported by dist/ (e.g. ${example}) but is not declared in dependencies, peerDependencies, or optionalDependencies of package.json. Add it to one of those — devDependencies does not ship with the package.`);
  }
  return findings;
}

function loadJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function checkVersionParity(root, pkg) {
  const pluginPath = join(root, ".claude-plugin", "plugin.json");
  const marketplacePath = join(root, ".claude-plugin", "marketplace.json");
  const plugin = loadJsonIfExists(pluginPath);
  const marketplace = loadJsonIfExists(marketplacePath);

  const missing = [];
  if (!plugin) missing.push(`Missing ${pluginPath} — cannot verify version parity.`);
  if (!marketplace) missing.push(`Missing ${marketplacePath} — cannot verify version parity.`);
  if (missing.length > 0) return missing;

  const marketplaceVersion = marketplace.plugins?.[0]?.version;
  if (marketplaceVersion === undefined) {
    return [`${marketplacePath} has no plugins[0].version — cannot verify version parity.`];
  }

  const pkgVersion = pkg.version;
  const pluginVersion = plugin.version;
  const inStep = pkgVersion === pluginVersion && pkgVersion === marketplaceVersion;
  if (inStep) return [];

  return [
    `Version mismatch: package.json=${pkgVersion}, .claude-plugin/plugin.json=${pluginVersion}, ` +
    `.claude-plugin/marketplace.json plugins[0].version=${marketplaceVersion}. ` +
    `Run "node scripts/sync-versions.mjs" to bring plugin.json and marketplace.json in line with package.json.`,
  ];
}

function checkManifest(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return [...checkDeclaredImports(root, pkg), ...checkVersionParity(root, pkg)];
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const root = process.argv[2] ?? process.cwd();
  const findings = checkManifest(root);
  if (findings.length > 0) {
    console.error(`check-manifest: ${findings.length} finding(s):\n`);
    for (const f of findings) console.error(`  - ${f}\n`);
    process.exit(1);
  }
  console.log("check-manifest: OK");
}

export { checkManifest };
