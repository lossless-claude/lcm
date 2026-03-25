import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the package version by trying multiple candidate paths so that
 * PKG_VERSION works correctly in both production (dist/src/daemon/) and
 * dev/test (src/daemon/) environments.
 */
export const PKG_VERSION = (() => {
  const candidates = [
    // Production / installed: dist/src/daemon → 3 levels up = package root
    join(__dirname, "..", "..", "..", "package.json"),
    // Dev / vitest: src/daemon → 2 levels up = package root
    join(__dirname, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return "0.0.0";
})();
