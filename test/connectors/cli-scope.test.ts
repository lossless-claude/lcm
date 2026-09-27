import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConnectorsCommands } from "../../src/cli/connectors.js";

vi.mock("../../src/hooks/fail-open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/fail-open.js")>()),
  runningFromPluginBundle: vi.fn(() => false),
}));

// `lcm connectors` run from a project whose root is the home directory: only --global reaches <agentDir>.
let home: string;
let log: string[];
const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lcm-cli-scope-"));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  vi.spyOn(process, "cwd").mockReturnValue(home);
  log = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { log.push(args.join(" ")); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function lcm(...args: string[]): Promise<string> {
  const program = new Command("lcm");
  registerConnectorsCommands(program);
  log = [];
  await program.parseAsync(["node", "lcm", "connectors", ...args]);
  return log.join("\n");
}

describe("lcm connectors scope", () => {
  const project = { hooks: [".omp", "hooks", "post", "lcm.ts"], mcp: [".omp", "mcp.json"] };
  const global = { hooks: ["agent", "hooks", "post", "lcm.ts"], mcp: ["agent", "mcp.json"] };

  it("without --global installs, lists, diagnoses and removes the project connectors", async () => {
    await lcm("install", "omp", "--type", "hooks");
    await lcm("install", "omp", "--type", "mcp");
    expect(existsSync(join(home, ...project.hooks))).toBe(true);
    expect(existsSync(join(home, ...project.mcp))).toBe(true);
    expect(existsSync(join(home, "agent"))).toBe(false);

    expect(await lcm("doctor", "omp")).toContain(`Path: ${join(home, ...project.hooks)}`);
    expect(await lcm("list", "--global")).toMatch(/Oh My Pi\s+-/);

    await lcm("remove", "omp", "--type", "hooks");
    expect(existsSync(join(home, ...project.hooks))).toBe(false);
  });

  it("with --global installs, lists, diagnoses and removes the agent-directory connectors", async () => {
    await lcm("install", "omp", "--type", "hooks", "--global");
    await lcm("install", "omp", "--type", "mcp", "--global");
    expect(existsSync(join(home, ...global.hooks))).toBe(true);
    expect(existsSync(join(home, ...global.mcp))).toBe(true);
    expect(existsSync(join(home, ".omp"))).toBe(false);

    expect(await lcm("doctor", "omp", "--global")).toContain(`Path: ${join(home, ...global.hooks)}`);
    expect(await lcm("list")).toMatch(/Oh My Pi\s+-/);

    await lcm("remove", "omp", "--type", "hooks", "--global");
    expect(existsSync(join(home, ...global.hooks))).toBe(false);
  });
});
