import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { installConnector, removeConnector, diagnoseConnector, listConnectors } from "../../src/connectors/installer.js";
import { OMP_HOOK_MARKER } from "../../src/connectors/omp-hooks.js";
import { runningFromPluginBundle } from "../../src/hooks/fail-open.js";

vi.mock("../../src/hooks/fail-open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/fail-open.js")>()),
  runningFromPluginBundle: vi.fn(() => false),
}));

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
    expect(diagnoseConnector({ agent: "omp", type: "hooks", cwd: root })).toMatchObject({
      status: "not-installed",
      installed: false,
    });
    const result = installConnector({ agent: "omp", type: "hooks", cwd: root });
    const expected = join(root, ".omp", "hooks", "post", "lcm.ts");

    expect(result).toMatchObject({ success: true, path: expected, requiresRestart: true });
    expect(readFileSync(expected, "utf8")).toContain(OMP_HOOK_MARKER);
    expect(diagnoseConnector({ agent: "omp", type: "hooks", cwd: root })).toMatchObject({
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
    const result = installConnector({ agent: "omp", type: "hooks", scope: "global" });
    const expected = join(agentDir, "hooks", "post", "lcm.ts");

    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("refuses to overwrite and remove a foreign file", () => {
    const path = join(root, ".omp", "hooks", "post", "lcm.ts");
    const foreign = "export default function foreign() {}\n";
    mkdirSync(join(root, ".omp", "hooks", "post"), { recursive: true });
    writeFileSync(path, foreign, { flag: "w" });

    expect(() => installConnector({ agent: "omp", type: "hooks", cwd: root })).toThrow(/not managed by lcm/);
    expect(removeConnector({ agent: "omp", type: "hooks", cwd: root })).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(foreign);
    expect(diagnoseConnector({ agent: "omp", type: "hooks", cwd: root })).toMatchObject({
      status: "partial",
      installed: false,
      active: null,
      trust: "unknown",
    });
  });

  it("reports a managed hook that differs from the shipped hook as outdated", () => {
    const path = installConnector({ agent: "omp", type: "hooks", cwd: root }).path;
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// from an older lcm\n`);

    expect(diagnoseConnector({ agent: "omp", type: "hooks", cwd: root })).toMatchObject({
      status: "partial",
      installed: true,
      complete: false,
      issues: [expect.stringContaining("differs from the shipped hook")],
    });
    installConnector({ agent: "omp", type: "hooks", cwd: root });
    expect(diagnoseConnector({ agent: "omp", type: "hooks", cwd: root })).toMatchObject({ status: "installed", complete: true, issues: [] });
  });

  it("removes a managed hook and prunes empty hook directories", () => {
    installConnector({ agent: "omp", type: "hooks", cwd: root });
    const path = join(root, ".omp", "hooks", "post", "lcm.ts");

    expect(removeConnector({ agent: "omp", type: "hooks", cwd: root })).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, ".omp", "hooks", "post"))).toBe(false);
    expect(existsSync(join(root, ".omp", "hooks"))).toBe(false);
  });
});

describe("OMP connector scope at the home directory", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("manages a project at the home directory at project scope", () => {
    const entry = { nodePath: "/usr/bin/node", cliPath: "/opt/lcm/dist/bin/lcm.js" };
    const hook = join(root, ".omp", "hooks", "post", "lcm.ts");
    const mcp = join(root, ".omp", "mcp.json");

    expect(installConnector({ agent: "omp", type: "hooks", cwd: homedir() }).path).toBe(hook);
    expect(installConnector({ agent: "omp", type: "mcp", cwd: homedir() }, entry).path).toBe(mcp);
    expect(diagnoseConnector({ agent: "omp", type: "hooks", cwd: homedir() }).path).toBe(hook);
    expect(listConnectors({ cwd: homedir() }).filter((c) => c.agentId === "omp").map((c) => c.path)).toEqual([hook, mcp]);
    expect(listConnectors({ scope: "global" }).filter((c) => c.agentId === "omp")).toEqual([]);
    expect(removeConnector({ agent: "omp", type: "hooks", cwd: homedir() })).toBe(true);
    expect(removeConnector({ agent: "omp", type: "mcp", cwd: homedir() })).toBe(true);
    expect(existsSync(hook)).toBe(false);
  });

  it("manages the agent directory at global scope, whatever the working directory", () => {
    const hook = join(root, "agent", "hooks", "post", "lcm.ts");

    expect(installConnector({ agent: "omp", type: "hooks", cwd: join(root, "elsewhere"), scope: "global" }).path).toBe(hook);
    expect(listConnectors({ scope: "global" }).filter((c) => c.agentId === "omp").map((c) => c.path)).toEqual([hook]);
    expect(listConnectors({ cwd: homedir() }).filter((c) => c.agentId === "omp")).toEqual([]);
    expect(removeConnector({ agent: "omp", type: "hooks", scope: "global" })).toBe(true);
  });
});

describe("OMP MCP registration", () => {
  const entry = { nodePath: "/usr/bin/node", cliPath: "/opt/lcm/dist/bin/lcm.js" };

  it("registers the lcm MCP server in the project .omp/mcp.json, keeping other servers", () => {
    const path = join(root, ".omp", "mcp.json");
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    const result = installConnector({ agent: "omp", type: "mcp", cwd: root }, entry);

    expect(result).toMatchObject({ success: true, path, requiresRestart: true });
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({
      other: { command: "other" },
      lcm: { type: "stdio", command: "/usr/bin/node", args: ["/opt/lcm/dist/bin/lcm.js", "mcp"] },
    });
    expect(listConnectors({ cwd: root })).toContainEqual({ agentId: "omp", agentName: "Oh My Pi", type: "mcp", path });
  });

  it("registers the global server in mcp.json beneath PI_CODING_AGENT_DIR", () => {
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const result = installConnector({ agent: "omp", type: "mcp", scope: "global" }, entry);

    expect(result.path).toBe(join(agentDir, "mcp.json"));
    expect(JSON.parse(readFileSync(result.path, "utf8")).mcpServers.lcm.args).toEqual(["/opt/lcm/dist/bin/lcm.js", "mcp"]);
    expect(removeConnector({ agent: "omp", type: "mcp", scope: "global" })).toBe(true);
    expect(JSON.parse(readFileSync(result.path, "utf8")).mcpServers).toEqual({});
  });

  it("refuses a malformed mcp.json instead of replacing the servers it holds", () => {
    const path = join(root, ".omp", "mcp.json");
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(() => installConnector({ agent: "omp", type: "mcp", cwd: root }, entry)).toThrow(/not a JSON object/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("refuses to register from the plugin bundle, whose CLI path the next plugin update deletes", () => {
    vi.mocked(runningFromPluginBundle).mockReturnValueOnce(true);

    expect(() => installConnector({ agent: "omp", type: "mcp", cwd: root })).toThrow(/npm CLI/);
    expect(existsSync(join(root, ".omp", "mcp.json"))).toBe(false);
  });

  it("removes only the lcm entry", () => {
    installConnector({ agent: "omp", type: "mcp", cwd: root }, entry);
    const path = join(root, ".omp", "mcp.json");

    expect(removeConnector({ agent: "omp", type: "mcp", cwd: root })).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({});
    expect(removeConnector({ agent: "omp", type: "mcp", cwd: root })).toBe(false);
  });
});
