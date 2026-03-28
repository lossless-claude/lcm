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
    // Gated behind LCM_BOOTSTRAP_INSTALL=1 (opt-in) to avoid unexpected npm install -g
    // side effects in environments where the user manages their own global packages.
    if (process.env.LCM_BOOTSTRAP_INSTALL === "1") {
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
    }
  } catch {}
}

// Delegate to the compiled CLI — process.argv passes through unchanged
const cliModule = join(__dirname, "dist", "bin", "lcm.js");
await import(pathToFileURL(cliModule).href);
