#!/usr/bin/env node
// MCP entrypoint for plugin system — auto-bootstraps on fresh install, then delegates to the built lcm MCP server.
// Uses import.meta.url to resolve paths relative to this file, so it works
// regardless of how the plugin cache resolves ${CLAUDE_PLUGIN_ROOT}.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

let __dirname = dirname(fileURLToPath(import.meta.url));
// If we're in .claude-plugin/, go up one level to find dist/
if (__dirname.endsWith(".claude-plugin")) {
  __dirname = join(__dirname, "..");
}

// Auto-bootstrap: install deps if node_modules is missing
if (!existsSync(join(__dirname, "node_modules"))) {
  try {
    execSync("npm install --silent", { cwd: __dirname, stdio: "pipe", timeout: 60000 });
  } catch (err) {
    // Don't throw: the import below will fail anyway if a package is truly
    // missing, and that failure reaches Claude Code as CONNECTION_CLOSED with
    // no detail. Logging here puts the real cause in the same debug log as
    // that symptom, next to each other, instead of only one of them existing.
    console.error("mcp.mjs: npm install failed:", err?.message ?? err);
  }
}

// Auto-build: compile TypeScript if dist/ is missing (fresh GitHub install)
if (!existsSync(join(__dirname, "dist"))) {
  try {
    execSync("npm run build --silent", { cwd: __dirname, stdio: "pipe", timeout: 120000 });
  } catch (err) {
    // Same reasoning as the install catch above: log instead of swallowing.
    console.error("mcp.mjs: npm run build failed:", err?.message ?? err);
  }
}

const serverModule = join(__dirname, "dist", "src", "mcp", "server.js");

// Use file:// URL for cross-platform compatibility (notably Windows)
const { startMcpServer } = await import(pathToFileURL(serverModule).href);
await startMcpServer();
