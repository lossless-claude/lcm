#!/usr/bin/env node
// MCP entrypoint for plugin system — delegates to the built lcm MCP server.
// Uses import.meta.url to resolve paths relative to this file, so it works
// regardless of how the plugin cache resolves ${CLAUDE_PLUGIN_ROOT}.
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

let __dirname = dirname(fileURLToPath(import.meta.url));
// If we're in .claude-plugin/, go up one level to find dist/
if (__dirname.endsWith(".claude-plugin")) {
  __dirname = join(__dirname, "..");
}
const serverModule = join(__dirname, "dist", "src", "mcp", "server.js");

const { startMcpServer } = await import(serverModule);
await startMcpServer();
