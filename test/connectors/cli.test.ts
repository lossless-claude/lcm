import { describe, it, expect } from "vitest";
import { AGENTS } from "../../src/connectors/registry.js";
import { installConnector, removeConnector, listConnectors } from "../../src/connectors/installer.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("connectors CLI integration", () => {
  it("list returns a non-empty registry with known agents", () => {
    expect(AGENTS.length).toBeGreaterThan(0);
    expect(AGENTS.some(a => a.id === "cursor")).toBe(true);
    expect(AGENTS.some(a => a.id === "claude-code")).toBe(true);
  });

  it("install + list + remove roundtrip for rules connector", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lcm-cli-"));
    // Install
    const result = installConnector("Cursor", "rules", tmp);
    expect(result.success).toBe(true);
    expect(existsSync(result.path)).toBe(true);

    // List finds it
    const found = listConnectors(tmp);
    expect(found.some(c => c.agentId === "cursor" && c.type === "rules")).toBe(true);

    // Remove
    const removed = removeConnector("Cursor", "rules", tmp);
    expect(removed).toBe(true);

    // List doesn't find it
    const after = listConnectors(tmp);
    expect(after.some(c => c.agentId === "cursor" && c.type === "rules")).toBe(false);
  });

  it("install + list + remove roundtrip for MCP connector", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lcm-cli-"));

    const result = installConnector("Cursor", "mcp", tmp);
    expect(result.success).toBe(true);

    const config = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(config.mcpServers.lcm).toBeDefined();

    const removed = removeConnector("Cursor", "mcp", tmp);
    expect(removed).toBe(true);
  });

  it("doctor reports no connectors for fresh workspace", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lcm-cli-"));
    const installed = listConnectors(tmp);
    expect(installed).toHaveLength(0);
  });
});
