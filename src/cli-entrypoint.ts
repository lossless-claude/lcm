import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the lcm CLI that belongs to this build, resolved from this
 * module's own location so it depends on neither cwd nor PATH: `bundle/lcm.js`
 * when running from the plugin bundle (this module is inlined next to it),
 * `dist/bin/lcm.js` when running from the npm package.
 */
export function cliEntrypoint(): string {
  const bundled = join(here, "lcm.js");
  return existsSync(bundled) ? bundled : join(here, "..", "bin", "lcm.js");
}

/** The plugin or package root: the directory holding `package.json`. */
export function packageRoot(): string {
  const candidates = [join(here, ".."), join(here, "..", "..")];
  return candidates.find((dir) => existsSync(join(dir, "package.json"))) ?? candidates[0];
}
