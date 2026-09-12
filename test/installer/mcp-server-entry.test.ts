import { describe, it, expect } from "vitest";
import { isAbsolute } from "node:path";
import { mcpServerEntry } from "../../src/installer/mcp-server-entry.js";

describe("mcpServerEntry", () => {
  it("defaults to absolute, measured paths — never bare 'lcm' or 'node'", () => {
    const entry = mcpServerEntry();
    expect(entry.command).not.toBe("lcm");
    expect(entry.command).not.toBe("node");
    expect(isAbsolute(entry.command)).toBe(true);
    expect(entry.args).toHaveLength(2);
    expect(isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args[1]).toBe("mcp");
  });

  it("defaults the node interpreter to the running process's own executable", () => {
    const entry = mcpServerEntry();
    expect(entry.command).toBe(process.execPath);
  });

  it("accepts overrides for both paths (used by tests / cross-checks)", () => {
    const entry = mcpServerEntry({ nodePath: "/opt/node", cliPath: "/opt/dist/bin/lcm.js" });
    expect(entry).toEqual({ command: "/opt/node", args: ["/opt/dist/bin/lcm.js", "mcp"] });
  });
});
