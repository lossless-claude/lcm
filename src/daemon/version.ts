import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build-time defines injected by esbuild into the plugin bundle (scripts/build-bundle.mjs):
// from bundle/ neither package.json nor dist/BUILD_ID is reachable, and an undefined
// version would silently disable the daemon ownership check. Absent under tsc and vitest.
declare const __PKG_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;

/**
 * Resolves the package version: the build-time define when bundled, else by trying
 * multiple candidate paths so that PKG_VERSION works correctly in both production
 * (dist/src/daemon/) and dev/test (src/daemon/) environments.
 *
 * Returns `undefined` when the version cannot be determined, so that callers
 * like ensureDaemon({ expectedVersion }) skip the version check rather than
 * restarting the daemon based on a stale "0.0.0" fallback.
 */
export const PKG_VERSION: string | undefined = (() => {
  if (typeof __PKG_VERSION__ === "string" && __PKG_VERSION__) return __PKG_VERSION__;
  const candidates = [
    // Production / installed: dist/src/daemon → 3 levels up = package root
    join(__dirname, "..", "..", "..", "package.json"),
    // Dev / vitest: src/daemon → 2 levels up = package root
    join(__dirname, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@lossless-claude/lcm" && typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return undefined;
})();

/**
 * Content fingerprint of a file: the first 16 hex chars of its sha256.
 * Throws when the file cannot be read; callers decide how to fail.
 */
export function fingerprintFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

/**
 * Reads a build id written next to the emitted JavaScript, trying each
 * candidate directory in order. Returns `undefined` when no readable,
 * well-formed id is found.
 */
export function readBuildIdFile(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    try {
      const id = readFileSync(join(dir, "BUILD_ID"), "utf-8").trim();
      if (/^[0-9a-f]{16}$/.test(id)) return id;
    } catch { /* try next candidate */ }
  }
  return undefined;
}

/**
 * Fingerprint of the running build.
 *
 * The primary source is `dist/BUILD_ID`, written at build time as a hash over
 * every emitted JavaScript file, so that *any* rebuild changes the id. The
 * fallback, used in a checkout that has not run the build step, is a content
 * hash of this module file alone.
 *
 * The fingerprint must depend on file *content*, never on filesystem metadata:
 * an installed copy of a build is byte-identical to its source but does not
 * carry its mtimes (copy tools such as `rsync -a` truncate them to whole
 * seconds), so an mtime-based id makes two identical builds compare unequal
 * and sends callers into an endless "stale daemon" restart loop.
 *
 * Two daemons with the same PKG_VERSION but different builds report different
 * BUILD_IDs, so callers can tell a stale daemon apart from a current one.
 * `undefined` when nothing can be read.
 */
export const BUILD_ID: string | undefined = (() => {
  if (typeof __BUILD_ID__ === "string" && /^[0-9a-f]{16}$/.test(__BUILD_ID__)) return __BUILD_ID__;
  // Production / installed: dist/src/daemon → 2 levels up = dist root
  const fromFile = readBuildIdFile([join(__dirname, "..", "..")]);
  if (fromFile) return fromFile;
  try {
    return fingerprintFile(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
})();
