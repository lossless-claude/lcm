import { cliEntrypoint } from "../cli-entrypoint.js";

export interface McpServerEntryOptions {
  /** Override for the node interpreter (tests only); defaults to the running process's own. */
  nodePath?: string;
  /** Override for the CLI entrypoint (tests only); defaults to the CLI of the running build (`bundle/lcm.js` from the plugin, `dist/bin/lcm.js` from npm). */
  cliPath?: string;
}

/**
 * The MCP server registration lcm writes into an agent's own (untracked) config —
 * `~/.claude/settings.json`, `.mcp.json`, `.qwen/mcp.json`, etc. Both fields are
 * absolute paths measured from the node process actually running the installer, so
 * the entry depends on neither PATH resolving `lcm` nor a shim's
 * `#!/usr/bin/env node` resolving a node interpreter. See
 * docs/design/mcp-interpreter-resolution.md.
 */
export function mcpServerEntry(options: McpServerEntryOptions = {}): { command: string; args: string[] } {
  const command = options.nodePath ?? process.execPath;
  const cliPath = options.cliPath ?? cliEntrypoint();
  return { command, args: [cliPath, "mcp"] };
}
