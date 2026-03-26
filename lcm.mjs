#!/usr/bin/env node
// CLI entrypoint — auto-bootstraps on fresh install, then delegates to the built lcm CLI.
// Hooks are registered in ~/.claude/settings.json with absolute paths at install time.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
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
    // Write hooks to settings.json if missing or stale (marketplace-install coverage).
    // Guard: only writes if hooksUpToDate returns false — safe to call on every boot.
    try {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      const { mergeClaudeSettings, hooksUpToDate } = await import(
        join(__dirname, "dist/src/installer/settings.js")
      );
      const lcmMjsPath = fileURLToPath(import.meta.url);
      const existing = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, "utf-8"))
        : {};
      if (!hooksUpToDate(existing, process.execPath, lcmMjsPath)) {
        const merged = mergeClaudeSettings(existing, {
          intent: "upsert",
          nodePath: process.execPath,
          lcmMjsPath,
        });
        const tmp = `${settingsPath}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(merged, null, 2));
        renameSync(tmp, settingsPath);
      }
    } catch {
      // Best-effort — never block hook execution
    }
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

// Version-stamp check: warn if plugin cache version ≠ running daemon version.
// Best-effort only — never blocks or throws. Uses 300ms timeout to stay non-disruptive.
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pluginVersion = require("./package.json").version;

  const daemonHealth = await new Promise((resolve) => {
    import("node:http").then(({ default: http }) => {
      const req = http.get(
        "http://127.0.0.1:3737/health",
        { timeout: 300 },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    }).catch(() => resolve(null));
  });

  if (daemonHealth?.version && daemonHealth.version !== pluginVersion) {
    process.stderr.write(
      `[lcm] version mismatch: plugin=${pluginVersion} daemon=${daemonHealth.version}` +
      ` — run \`lcm install\` to update\n`,
    );
  }
} catch {
  // Never block hook execution on version check failure
}

// Delegate to the compiled CLI — process.argv passes through unchanged
const cliModule = join(__dirname, "dist", "bin", "lcm.js");
await import(pathToFileURL(cliModule).href);
