import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, emptyPluginDir } from "../../src/llm/claude-process.js";

describe("buildClaudeArgs", () => {
  it("isolates the subprocess from the user's plugins, MCP servers and settings", () => {
    const args = buildClaudeArgs("test-model");
    for (const flag of ["--plugin-dir", "--mcp-config", "--setting-sources"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(emptyPluginDir());
    expect(existsSync(emptyPluginDir())).toBe(true);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--bare");
  });

  it("uses a per-process private directory and caches it", () => {
    expect(emptyPluginDir()).toBe(emptyPluginDir());
    expect(emptyPluginDir().startsWith(tmpdir())).toBe(true);
    expect((statSync(emptyPluginDir()).mode & 0o777) === 0o700 || process.platform === "win32").toBe(true);
  });
});
