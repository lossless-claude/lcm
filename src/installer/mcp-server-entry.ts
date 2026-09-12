import { fileURLToPath } from "node:url";

/**
 * Absolute path to the installed lcm CLI entrypoint (dist/bin/lcm.js), resolved
 * from this compiled file's own location so it works regardless of cwd or PATH.
 * Same technique as `codex-hooks.ts`'s `installedEntrypoint`.
 */
function installedCliEntrypoint(): string {
  return fileURLToPath(new URL("../../bin/lcm.js", import.meta.url));
}

export interface McpServerEntryOptions {
  /** Override for the node interpreter (tests only); defaults to the running process's own. */
  nodePath?: string;
  /** Override for the CLI entrypoint (tests only); defaults to the installed dist/bin/lcm.js. */
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
  const cliPath = options.cliPath ?? installedCliEntrypoint();
  return { command, args: [cliPath, "mcp"] };
}
