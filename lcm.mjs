#!/usr/bin/env node
// CLI entrypoint for plugin hooks — auto-bootstraps on fresh install, then delegates to the built lcm CLI.
// Used by plugin.json hooks via ${CLAUDE_PLUGIN_ROOT}/lcm.mjs so no global binary is required.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-bootstrap: install deps if node_modules is missing
if (!existsSync(join(__dirname, "node_modules"))) {
  try {
    execSync("npm install --silent", { cwd: __dirname, stdio: "pipe", timeout: 60000 });
  } catch {}
}

// Auto-build: compile TypeScript if dist/ is missing (fresh GitHub/marketplace install)
if (!existsSync(join(__dirname, "dist"))) {
  try {
    execSync("npm run build --silent", { cwd: __dirname, stdio: "pipe", timeout: 120000 });
    // Register as a global binary so `lcm` is available in PATH.
    // Best-effort: silently skip if the environment disallows global installs (managed npm, etc.).
    try {
      execSync("npm install -g . --silent", { cwd: __dirname, stdio: "pipe", timeout: 60000 });
    } catch (error) {
      const message =
        error instanceof Error && typeof error.message === "string"
          ? error.message
          : String(error);
      console.error(
        "[lcm] Warning: Failed to globally install the lcm CLI. " +
          "The `lcm` binary may not be available in your PATH. " +
          "You can manually run `npm install -g .` in the plugin directory if desired.\n" +
          `Underlying error: ${message}`,
      );
    }
  } catch {}
}

// Delegate to the compiled CLI. argv[1] must be rewritten to point at the CLI rather
// than at this wrapper: dist/bin/lcm.js only calls main() when realpath(argv[1]) matches its
// own path, so leaving argv[1] as lcm.mjs makes every plugin hook a silent no-op.
const cliModule = join(__dirname, "dist", "bin", "lcm.js");
process.argv[1] = cliModule;
await import(pathToFileURL(cliModule).href);
