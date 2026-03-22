import { describe, it, expect } from "vitest";
import { AGENTS, findAgent, getAgentsByCategory } from "../../src/connectors/registry.js";
import { CONNECTOR_TYPES, requiresRestart } from "../../src/connectors/types.js";

describe("connector registry", () => {
  it("has exactly 22 agents", () => {
    expect(AGENTS).toHaveLength(22);
  });

  it("all agents have required fields", () => {
    for (const agent of AGENTS) {
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      expect(agent.category).toBeTruthy();
      expect(CONNECTOR_TYPES).toContain(agent.defaultType);
      expect(agent.supportedTypes.length).toBeGreaterThan(0);
      expect(agent.supportedTypes).toContain(agent.defaultType);
    }
  });

  it("all agent ids are unique", () => {
    const ids = AGENTS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("configPaths and supportedTypes are aligned", () => {
    for (const agent of AGENTS) {
      // configPaths keys must be in supportedTypes
      for (const key of Object.keys(agent.configPaths)) {
        expect(agent.supportedTypes, `${agent.id}: configPath "${key}" not in supportedTypes`).toContain(key);
      }
      // supportedTypes must have a configPath (except hook which is managed by plugin system,
      // and except mcp when it's the defaultType with no path — means manual configuration)
      for (const type of agent.supportedTypes) {
        if (type === 'hook') continue;
        if (type === 'mcp' && !agent.configPaths['mcp']) continue;
        expect(agent.configPaths, `${agent.id}: supportedType "${type}" has no configPath`).toHaveProperty(type);
      }
    }
  });

  it("getAgentsByCategory filters correctly", () => {
    const cli = getAgentsByCategory("cli");
    expect(cli.length).toBe(7);
    expect(cli.every(a => a.category === "cli")).toBe(true);
  });

  it("findAgent works by id and name", () => {
    expect(findAgent("claude-code")?.name).toBe("Claude Code");
    expect(findAgent("Claude Code")?.id).toBe("claude-code");
    expect(findAgent("nonexistent")).toBeUndefined();
  });

  it("requiresRestart returns false only for rules", () => {
    expect(requiresRestart("rules")).toBe(false);
    expect(requiresRestart("hook")).toBe(true);
    expect(requiresRestart("mcp")).toBe(true);
    expect(requiresRestart("skill")).toBe(true);
  });
});
