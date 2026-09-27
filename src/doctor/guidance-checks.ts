import { join } from "node:path";
import type { CheckResult, DoctorDeps } from "./types.js";
import { diagnoseCodexHooks } from "../connectors/codex-hooks.js";
import { diagnoseOmpHooks } from "../connectors/omp-hooks.js";
import { runningFromPluginBundle } from "../hooks/fail-open.js";

/**
 * The doctor check that verifies each guidance row of the connector registry
 * (`Agent.guidance` in src/connectors/registry.ts), keyed `<agent id>:<via>`.
 * `runDoctor` runs the Claude Code checks itself; this module adds Codex and OMP.
 */
export const GUIDANCE_CHECK_NAMES: Readonly<Record<string, string>> = {
  "claude-code:hook": "hooks",
  "claude-code:lcm-md": "lcm-md",
  "claude-code:mcp": "mcp-lcm",
  "codex:hooks": "codex-hooks",
  "codex:mcp": "codex-mcp",
  "omp:hooks": "omp-hooks",
  "omp:mcp": "omp-mcp",
};

const CATEGORY = "Guidance";

interface HookDiagnosis {
  path: string;
  installed: boolean;
  complete: boolean;
  issues: string[];
}

function onPath(deps: DoctorDeps, command: string): boolean {
  return deps.spawnSync("sh", ["-c", `command -v ${command}`], {}).status === 0;
}

function readOrEmpty(deps: DoctorDeps, path: string): string {
  if (!deps.existsSync(path)) return "";
  try { return deps.readFileSync(path, "utf-8"); } catch { return ""; }
}

// An entry counts only when OMP can start it: a command, and arguments that run `mcp`.
function registersLcmMcp(deps: DoctorDeps, path: string): boolean {
  let entry: { command?: unknown; args?: unknown } | undefined;
  try { entry = JSON.parse(readOrEmpty(deps, path) || "{}")?.mcpServers?.lcm; } catch { return false; }
  return typeof entry?.command === "string" && Array.isArray(entry.args) && entry.args.includes("mcp");
}

/** A hook connector counts when installed globally or in the current project. */
function hookResult(name: string, diagnoses: HookDiagnosis[], fix: string): CheckResult {
  const installed = diagnoses.find((d) => d.installed && d.complete) ?? diagnoses.find((d) => d.installed);
  if (!installed) {
    // A malformed or foreign file blocks the install command too, so name it instead of the command.
    const unusable = diagnoses.find((d) => d.issues.length > 0);
    return unusable
      ? { name, category: CATEGORY, status: "warn", message: `${unusable.path}: ${unusable.issues.join("; ")} — the agent never receives the learning instruction\n     Fix: repair or remove that file, then ${fix}` }
      : { name, category: CATEGORY, status: "warn", message: `hooks not installed — the agent never receives the learning instruction\n     Fix: ${fix}` };
  }
  if (!installed.complete) {
    return { name, category: CATEGORY, status: "warn", message: `${installed.path}: ${installed.issues.join("; ")}\n     Fix: ${fix}` };
  }
  return { name, category: CATEGORY, status: "pass", message: `learning instruction via ${installed.path}` };
}

function mcpResult(name: string, found: string | undefined, missing: Omit<CheckResult, "name" | "category">): CheckResult {
  return found
    ? { name, category: CATEGORY, status: "pass", message: `MCP server registered in ${found}` }
    : { name, category: CATEGORY, ...missing };
}

function codexHooksResult(deps: DoctorDeps, cwd: string): CheckResult {
  const name = GUIDANCE_CHECK_NAMES["codex:hooks"];
  // The hooks name the npm CLI, so compared with the plugin bundle's own path they would always differ.
  if (runningFromPluginBundle()) {
    return { name, category: CATEGORY, status: "pass", message: "not checked from the Claude Code plugin; run lcm doctor from the npm CLI" };
  }
  const hookPaths = [join(deps.homedir, ".codex", "hooks.json"), join(cwd, ".codex", "hooks.json")];
  return hookResult(name, hookPaths.map((p) => diagnoseCodexHooks(p)), "lcm install  (from the npm CLI)");
}

function addCodexChecks(results: CheckResult[], deps: DoctorDeps, cwd: string): void {
  results.push(codexHooksResult(deps, cwd));
  const configPaths = [join(deps.homedir, ".codex", "config.toml"), join(cwd, ".codex", "config.toml")];
  results.push(mcpResult(GUIDANCE_CHECK_NAMES["codex:mcp"],
    configPaths.find((p) => /^\s*\[mcp_servers\.lcm\]/m.test(readOrEmpty(deps, p))),
    { status: "pass", message: "MCP server not registered (optional; the learning instruction names CLI commands)\n     To add it: lcm connectors install codex --type mcp" }));
}

function addOmpChecks(results: CheckResult[], deps: DoctorDeps, cwd: string): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(deps.homedir, ".omp", "agent");
  const hookPaths = [join(agentDir, "hooks", "post", "lcm.ts"), join(cwd, ".omp", "hooks", "post", "lcm.ts")];
  results.push(hookResult(GUIDANCE_CHECK_NAMES["omp:hooks"], hookPaths.map(diagnoseOmpHooks), "lcm install"));
  results.push(mcpResult(GUIDANCE_CHECK_NAMES["omp:mcp"],
    [join(agentDir, "mcp.json"), join(cwd, ".omp", "mcp.json")].find((p) => registersLcmMcp(deps, p)),
    { status: "warn", message: "MCP server not registered — the agent cannot call lcm's tools\n     Fix: lcm install  (from the npm CLI), or lcm connectors install omp --type mcp --global" }));
}

/** Codex and OMP guidance checks, for each harness whose CLI is on PATH. */
export function addHarnessGuidanceChecks(results: CheckResult[], deps: DoctorDeps): void {
  const cwd = deps.cwd ?? process.cwd();
  if (onPath(deps, "codex")) addCodexChecks(results, deps, cwd);
  if (onPath(deps, "omp")) addOmpChecks(results, deps, cwd);
}
