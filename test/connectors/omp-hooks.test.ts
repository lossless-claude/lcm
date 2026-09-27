import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { installConnector, removeConnector, diagnoseConnector, listConnectors } from "../../src/connectors/installer.js";
import { OMP_HOOK_MARKER } from "../../src/connectors/omp-hooks.js";

let root: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = mkdtempSync(join(tmpdir(), "lcm-omp-connector-"));
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("OMP connector installation", () => {
  it("writes and diagnoses the project hook", () => {
    expect(diagnoseConnector("omp", "hooks", root)).toMatchObject({
      status: "not-installed",
      installed: false,
    });
    const result = installConnector("omp", "hooks", root);
    const expected = join(root, ".omp", "hooks", "post", "lcm.ts");

    expect(result).toMatchObject({ success: true, path: expected, requiresRestart: true });
    expect(readFileSync(expected, "utf8")).toContain(OMP_HOOK_MARKER);
    expect(diagnoseConnector("omp", "hooks", root)).toMatchObject({
      status: "installed",
      installed: true,
      complete: true,
      active: null,
      trust: "unknown",
    });
  });

  it("writes the global hook beneath PI_CODING_AGENT_DIR", () => {
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const result = installConnector("omp", "hooks", homedir());
    const expected = join(agentDir, "hooks", "post", "lcm.ts");

    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("refuses to overwrite and remove a foreign file", () => {
    const path = join(root, ".omp", "hooks", "post", "lcm.ts");
    const foreign = "export default function foreign() {}\n";
    mkdirSync(join(root, ".omp", "hooks", "post"), { recursive: true });
    writeFileSync(path, foreign, { flag: "w" });

    expect(() => installConnector("omp", "hooks", root)).toThrow(/not managed by lcm/);
    expect(removeConnector("omp", "hooks", root)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(foreign);
    expect(diagnoseConnector("omp", "hooks", root)).toMatchObject({
      status: "partial",
      installed: false,
      active: null,
      trust: "unknown",
    });
  });

  it("removes a managed hook and prunes empty hook directories", () => {
    installConnector("omp", "hooks", root);
    const path = join(root, ".omp", "hooks", "post", "lcm.ts");

    expect(removeConnector("omp", "hooks", root)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, ".omp", "hooks", "post"))).toBe(false);
    expect(existsSync(join(root, ".omp", "hooks"))).toBe(false);
  });
});

describe("OMP MCP registration", () => {
  const entry = { nodePath: "/usr/bin/node", cliPath: "/opt/lcm/dist/bin/lcm.js" };

  it("registers the lcm MCP server in the project .omp/mcp.json, keeping other servers", () => {
    const path = join(root, ".omp", "mcp.json");
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    const result = installConnector("omp", "mcp", root, entry);

    expect(result).toMatchObject({ success: true, path, requiresRestart: true });
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({
      other: { command: "other" },
      lcm: { type: "stdio", command: "/usr/bin/node", args: ["/opt/lcm/dist/bin/lcm.js", "mcp"] },
    });
    expect(listConnectors(root)).toContainEqual({ agentId: "omp", agentName: "Oh My Pi", type: "mcp", path });
  });

  it("registers the global server in mcp.json beneath PI_CODING_AGENT_DIR", () => {
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const result = installConnector("omp", "mcp", homedir(), entry);

    expect(result.path).toBe(join(agentDir, "mcp.json"));
    expect(JSON.parse(readFileSync(result.path, "utf8")).mcpServers.lcm.args).toEqual(["/opt/lcm/dist/bin/lcm.js", "mcp"]);
    expect(removeConnector("omp", "mcp", homedir())).toBe(true);
    expect(JSON.parse(readFileSync(result.path, "utf8")).mcpServers).toEqual({});
  });

  it("removes only the lcm entry", () => {
    installConnector("omp", "mcp", root, entry);
    const path = join(root, ".omp", "mcp.json");

    expect(removeConnector("omp", "mcp", root)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({});
    expect(removeConnector("omp", "mcp", root)).toBe(false);
  });
});
