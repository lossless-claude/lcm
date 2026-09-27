import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../../src/connectors/registry.js";
import { installConnector } from "../../src/connectors/installer.js";
import { addHarnessGuidanceChecks, GUIDANCE_CHECK_NAMES } from "../../src/doctor/guidance-checks.js";
import type { CheckResult, DoctorDeps } from "../../src/doctor/types.js";

vi.mock("../../src/hooks/fail-open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/fail-open.js")>()),
  runningFromPluginBundle: vi.fn(() => false),
}));
import { runningFromPluginBundle } from "../../src/hooks/fail-open.js";

let home: string;
let project: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  home = mkdtempSync(join(tmpdir(), "lcm-guidance-home-"));
  project = mkdtempSync(join(tmpdir(), "lcm-guidance-project-"));
  process.env.PI_CODING_AGENT_DIR = join(home, ".omp", "agent");
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function deps(onPath: string[]): DoctorDeps {
  return {
    existsSync,
    readFileSync: (path, encoding) => readFileSync(path, encoding as BufferEncoding),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    spawnSync: (_cmd, args) => ({ status: onPath.some((c) => args[1] === `command -v ${c}`) ? 0 : 1, stdout: "", stderr: "" }),
    fetch: vi.fn(),
    homedir: home,
    lcmHome: join(home, ".lossless-claude"),
    platform: "darwin",
    cwd: project,
  };
}

function run(onPath: string[]): Record<string, CheckResult> {
  const results: CheckResult[] = [];
  addHarnessGuidanceChecks(results, deps(onPath));
  return Object.fromEntries(results.map((r) => [r.name, r]));
}

describe("guidance table", () => {
  it("has one doctor check per registry row, and no check without a row", () => {
    const rows = AGENTS.flatMap((a) => (a.guidance ?? []).map((g) => `${a.id}:${g.via}`));
    expect(rows.sort()).toEqual(Object.keys(GUIDANCE_CHECK_NAMES).sort());
  });

  it("gives every native harness the learning instruction", () => {
    for (const id of ["claude-code", "codex", "omp"]) {
      const agent = AGENTS.find((a) => a.id === id);
      expect(agent?.guidance?.map((g) => g.surface)).toContain("learning-instruction");
    }
  });
});

describe("harness guidance checks", () => {
  it("runs no check for a harness whose CLI is not on PATH", () => {
    expect(run([])).toEqual({});
  });

  it("warns when the OMP hook and MCP server are missing", () => {
    const results = run(["omp"]);
    expect(results["omp-hooks"]).toMatchObject({ status: "warn", message: expect.stringContaining("Fix: lcm install") });
    expect(results["omp-mcp"]).toMatchObject({ status: "warn", message: expect.stringContaining("--type mcp --global") });
  });

  it("passes when the OMP hook and MCP server are installed globally", () => {
    const hook = installConnector("omp", "hooks", homedir()).path;
    const mcp = installConnector("omp", "mcp", homedir()).path;
    expect(hook.startsWith(home)).toBe(true);
    const results = run(["omp"]);
    expect(results["omp-hooks"]).toMatchObject({ status: "pass", message: `learning instruction via ${hook}` });
    expect(results["omp-mcp"]).toMatchObject({ status: "pass", message: `MCP server registered in ${mcp}` });
  });

  it("names a foreign OMP hook file, which blocks the install command", () => {
    const path = join(project, ".omp", "hooks", "post", "lcm.ts");
    mkdirSync(join(project, ".omp", "hooks", "post"), { recursive: true });
    writeFileSync(path, "export default function foreign() {}\n");
    const result = run(["omp"])["omp-hooks"];
    expect(result.status).toBe("warn");
    expect(result.message).toContain(`${path}: hook file is not managed by lcm`);
    expect(result.message).toContain("repair or remove that file");
  });

  it("names a malformed Codex hooks file", () => {
    const path = join(project, ".codex", "hooks.json");
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(path, "{ not json");
    const result = run(["codex"])["codex-hooks"];
    expect(result.status).toBe("warn");
    expect(result.message.startsWith(`${path}: `)).toBe(true);
    expect(result.message).toContain("repair or remove that file");
  });

  it("does not count an OMP MCP entry that cannot start the server", () => {
    const path = join(project, ".omp", "mcp.json");
    mkdirSync(join(project, ".omp"), { recursive: true });
    for (const lcm of [{}, true, { command: "node", args: ["lcm.js"] }]) {
      writeFileSync(path, JSON.stringify({ mcpServers: { lcm } }));
      expect(run(["omp"])["omp-mcp"].status).toBe("warn");
    }
  });

  it("warns about an outdated OMP hook", () => {
    const hook = installConnector("omp", "hooks", project).path;
    writeFileSync(hook, `${readFileSync(hook, "utf8")}\n// from an older lcm\n`);
    expect(run(["omp"])["omp-hooks"]).toMatchObject({ status: "warn", message: expect.stringContaining("differs from the shipped hook") });
  });

  it("warns when the Codex hooks are missing and treats Codex MCP as optional", () => {
    const results = run(["codex"]);
    expect(results["codex-hooks"]).toMatchObject({ status: "warn", message: expect.stringContaining("never receives the learning instruction") });
    expect(results["codex-mcp"]).toMatchObject({ status: "pass", message: expect.stringContaining("optional") });
  });

  it("leaves the Codex hooks unchecked from the plugin bundle, whose CLI path the hooks never name", () => {
    vi.mocked(runningFromPluginBundle).mockReturnValueOnce(true);
    expect(run(["codex"])["codex-hooks"]).toMatchObject({ status: "pass", message: expect.stringContaining("npm CLI") });
  });

  it("passes when the Codex hooks and MCP server are installed in the project", () => {
    const hooks = installConnector("codex", "hooks", project).path;
    const config = join(project, ".codex", "config.toml");
    writeFileSync(config, '[mcp_servers.lcm]\ncommand = "lcm"\nargs = ["mcp"]\n');
    const results = run(["codex"]);
    expect(results["codex-hooks"]).toMatchObject({ status: "pass", message: `learning instruction via ${hooks}` });
    expect(results["codex-mcp"]).toMatchObject({ status: "pass", message: `MCP server registered in ${config}` });
  });
});
