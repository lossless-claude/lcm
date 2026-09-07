import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, emptyPluginDir } from "../../src/llm/claude-process.js";

describe("buildClaudeArgs", () => {
  it("isolates the subprocess from the user's plugins, MCP servers and settings", () => {
    const args = buildClaudeArgs("test-model");
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(emptyPluginDir());
    expect(existsSync(emptyPluginDir())).toBe(true);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--bare");
  });
});
