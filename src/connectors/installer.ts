import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Agent, ConnectorLocation, ConnectorRequest, ConnectorType } from "./types.js";
import { requiresRestart } from "./types.js";
import { LCM_MARKERS } from "./constants.js";
import { generateContent } from "./template-service.js";
import { findAgent, AGENTS, LEGACY_SKILL_PATHS } from "./registry.js";
import { mcpServerEntry } from "../installer/mcp-server-entry.js";
import { runningFromPluginBundle } from "../hooks/fail-open.js";
import {
  diagnoseCodexHooks,
  installCodexHooks,
  removeCodexHooks,
  type CodexHookCommandOptions,
  type CodexHooksDiagnosis,
} from "./codex-hooks.js";
import {
  diagnoseOmpHooks,
  installOmpHooks,
  ompAgentDir,
  removeOmpHooks,
  type OmpHooksDiagnosis,
} from "./omp-hooks.js";

export interface InstallResult {
  success: boolean;
  path: string;
  requiresRestart: boolean;
  manual?: string;
  notice?: string;
}

export interface InstalledConnector {
  agentId: string;
  agentName: string;
  type: ConnectorType;
  path: string;
}

function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath.startsWith('~/')) {
    return join(homedir(), configPath.slice(2));
  }
  return join(cwd, configPath);
}

// The directory an agent's relative config paths resolve against: the home directory at global scope.
function rootOf({ cwd = process.cwd(), scope = 'project' }: ConnectorLocation): string {
  return scope === 'global' ? homedir() : cwd;
}

// OMP has distinct project and global roots: its project files live under the
// workspace's .omp directory, while the user files live under agentDir.
function resolveAgentConfigPath(agentId: string, connectorType: ConnectorType, configPath: string, location: ConnectorLocation): string {
  if (agentId === "omp" && location.scope === 'global') {
    if (connectorType === "hooks") return join(ompAgentDir(), "hooks", "post", "lcm.ts");
    if (connectorType === "mcp") return join(ompAgentDir(), "mcp.json");
  }
  return resolveConfigPath(configPath, rootOf(location));
}

function requireAgent(agentIdOrName: string): Agent {
  const agent = findAgent(agentIdOrName);
  if (!agent) throw new Error(`Unknown agent: ${agentIdOrName}`);
  return agent;
}

function removeMarkers(content: string): string {
  const startIdx = content.indexOf(LCM_MARKERS.START);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(LCM_MARKERS.END);
  if (endIdx === -1) return content;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + LCM_MARKERS.END.length);
  return (before.trimEnd() + after.trimStart()).trim();
}

// Strategy 1: Markdown targets (rules, skill)
function installMarkdown(content: string, filePath: string, writeMode: 'append' | 'overwrite'): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (writeMode === 'append') {
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
    // Remove old markers if present before re-appending
    const cleaned = removeMarkers(existing);
    writeFileSync(filePath, cleaned + (cleaned.endsWith('\n') || cleaned === '' ? '' : '\n') + content + '\n');
  } else {
    writeFileSync(filePath, content + '\n');
  }
}

// Strategy 2: Structured targets (MCP JSON)
function writeFileCreatingDir(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

// The existing config object, or {} when the file is missing. A file that is not a
// JSON object is refused: rewriting it would drop the servers it holds.
function readJsonObject(filePath: string): any {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { parsed = undefined; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Cannot register the MCP server: ${filePath} is not a JSON object; fix or remove it`);
  }
  return parsed;
}

function installMcpJson(filePath: string, options: CodexHookCommandOptions = {}): void {
  // The entry names the running CLI; from the plugin bundle that is a versioned cache path the next plugin update deletes.
  if (runningFromPluginBundle()) {
    throw new Error("Cannot register the MCP server from the Claude Code plugin; run this command from the npm CLI");
  }
  const writeFile = options.writeFile ?? writeFileCreatingDir;
  const existing = readJsonObject(filePath);
  if (typeof existing.mcpServers !== 'object' || existing.mcpServers === null || Array.isArray(existing.mcpServers)) {
    existing.mcpServers = {};
  }
  existing.mcpServers.lcm = { type: 'stdio', ...mcpServerEntry({ nodePath: options.nodePath, cliPath: options.cliPath }) };
  writeFile(filePath, JSON.stringify(existing, null, 2) + '\n');
}

// Removes the skill file (and its now-empty lcm-memory directory) at an
// agent's previous skill config path, if one still exists there.
function removeLegacySkill(agentId: string, cwd: string): void {
  const legacyBase = LEGACY_SKILL_PATHS[agentId];
  if (!legacyBase) return;
  const legacyDir = join(resolveConfigPath(legacyBase, cwd), 'lcm-memory');
  const legacyPath = join(legacyDir, 'SKILL.md');
  if (!existsSync(legacyPath)) return;
  unlinkSync(legacyPath);
  try { rmdirSync(legacyDir); } catch { /* not empty or already gone */ }
}

function removeMcpJson(filePath: string): boolean {
  if (filePath.endsWith('.toml')) return false; // TOML removal not supported
  if (!existsSync(filePath)) return false;
  let config: any;
  try { config = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return false; }
  if (!config.mcpServers?.lcm) return false;
  delete config.mcpServers.lcm;
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

export function installConnector(request: ConnectorRequest, options: CodexHookCommandOptions = {}): InstallResult {
  const agent = requireAgent(request.agent);

  const connectorType = request.type ?? agent.defaultType;
  if (!agent.supportedTypes.includes(connectorType)) {
    throw new Error(`Agent "${agent.name}" does not support connector type "${connectorType}". Supported: ${agent.supportedTypes.join(', ')}`);
  }

  if (connectorType === 'hook') {
    return {
      success: true,
      path: '',
      requiresRestart: true,
      manual: 'Hook connectors are managed by the plugin system. Run `lcm install` to set up hooks.',
    };
  }

  const configPath = agent.configPaths[connectorType];

  if (connectorType === 'mcp' && !configPath) {
    return { success: true, path: '', requiresRestart: true, manual: `Add the lcm MCP server to ${agent.name} manually:\n\nServer name: lcm\nCommand: lcm\nArgs: mcp` };
  }
  if (!configPath) throw new Error(`No config path defined for ${agent.name} with type ${connectorType}`);

  const resolvedPath = resolveAgentConfigPath(agent.id, connectorType, configPath, request);

  if (connectorType === 'hooks') {
    if (agent.id === "omp") {
      installOmpHooks(resolvedPath, options);
      return {
        success: true,
        path: resolvedPath,
        requiresRestart: requiresRestart(connectorType),
      };
    }
    installCodexHooks(resolvedPath, options);
    return {
      success: true,
      path: resolvedPath,
      requiresRestart: requiresRestart(connectorType),
      notice: 'Codex requires trust review for non-managed hooks. Review this connector with /hooks after restarting Codex.',
    };
  }

  if (connectorType === 'mcp') {
    if (configPath.endsWith('.toml')) {
      return {
        success: true,
        path: resolvedPath,
        requiresRestart: requiresRestart(connectorType),
        manual: `Add the following to ${configPath}:\n\n[mcp_servers.lcm]\ncommand = "lcm"\nargs = ["mcp"]`,
      };
    }
    installMcpJson(resolvedPath, options);
    return { success: true, path: resolvedPath, requiresRestart: requiresRestart(connectorType) };
  }

  if (connectorType === 'skill') {
    const content = generateContent(agent, connectorType);
    const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
    installMarkdown(content, skillPath, 'overwrite');
    removeLegacySkill(agent.id, rootOf(request));
    return { success: true, path: skillPath, requiresRestart: requiresRestart(connectorType) };
  }

  // rules
  const content = generateContent(agent, connectorType);
  const writeMode = agent.writeMode ?? 'overwrite';
  installMarkdown(content, resolvedPath, writeMode);
  return { success: true, path: resolvedPath, requiresRestart: requiresRestart(connectorType) };
}

export function removeConnector(request: ConnectorRequest): boolean {
  const agent = requireAgent(request.agent);

  const connectorType = request.type ?? agent.defaultType;
  const configPath = agent.configPaths[connectorType];
  if (!configPath) return false;

  const resolvedPath = resolveAgentConfigPath(agent.id, connectorType, configPath, request);

  if (connectorType === 'hooks') {
    return agent.id === "omp"
      ? removeOmpHooks(resolvedPath)
      : removeCodexHooks(resolvedPath);
  }

  if (connectorType === 'mcp') {
    return removeMcpJson(resolvedPath);
  }
  if (connectorType === 'skill') {
    const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
    const existed = existsSync(skillPath);
    if (existed) unlinkSync(skillPath);
    const legacyBase = LEGACY_SKILL_PATHS[agent.id];
    const root = rootOf(request);
    const hadLegacy = !!legacyBase && existsSync(join(resolveConfigPath(legacyBase, root), 'lcm-memory', 'SKILL.md'));
    removeLegacySkill(agent.id, root);
    return existed || hadLegacy;
  }

  // rules: remove markers from file
  if (!existsSync(resolvedPath)) return false;
  const content = readFileSync(resolvedPath, 'utf-8');
  if (!content.includes(LCM_MARKERS.START)) return false;
  const cleaned = removeMarkers(content);
  if (cleaned.trim() === '') {
    unlinkSync(resolvedPath);
  } else {
    writeFileSync(resolvedPath, cleaned + '\n');
  }
  return true;
}

export function listConnectors(location: ConnectorLocation = {}): InstalledConnector[] {
  const installed: InstalledConnector[] = [];

  for (const agent of AGENTS) {
    for (const type of agent.supportedTypes) {
      const configPath = agent.configPaths[type as ConnectorType];
      if (!configPath) continue;
      const resolvedPath = resolveAgentConfigPath(agent.id, type, configPath, location);

      if (type === 'hooks') {
        const diagnosis = agent.id === "omp"
          ? diagnoseOmpHooks(resolvedPath)
          : diagnoseCodexHooks(resolvedPath);
        if (diagnosis.installed) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
        }
      } else if (type === 'mcp') {
        if (resolvedPath.endsWith('.toml')) continue; // Skip TOML files
        if (existsSync(resolvedPath)) {
          try {
            const config = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
            if (config.mcpServers?.lcm) {
              installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
            }
          } catch {
            // ignore malformed JSON
          }
        }
      } else if (type === 'skill') {
        const skillPath = join(resolvedPath, 'lcm-memory', 'SKILL.md');
        if (existsSync(skillPath)) {
          installed.push({ agentId: agent.id, agentName: agent.name, type, path: skillPath });
        }
      } else {
        // rules / hook
        if (existsSync(resolvedPath)) {
          const content = readFileSync(resolvedPath, 'utf-8');
          if (content.includes(LCM_MARKERS.START)) {
            installed.push({ agentId: agent.id, agentName: agent.name, type, path: resolvedPath });
          }
        }
      }
    }
  }

  return installed;
}

export function diagnoseConnector(
  request: ConnectorRequest,
  options: CodexHookCommandOptions = {},
): CodexHooksDiagnosis | OmpHooksDiagnosis {
  const agent = requireAgent(request.agent);
  const connectorType = request.type ?? agent.defaultType;
  if (connectorType !== 'hooks') {
    throw new Error(`Detailed connector diagnostics are not available for type "${connectorType}"`);
  }
  if (!agent.supportedTypes.includes(connectorType)) {
    throw new Error(`Agent "${agent.name}" does not support connector type "${connectorType}". Supported: ${agent.supportedTypes.join(', ')}`);
  }
  const configPath = agent.configPaths.hooks;
  if (!configPath) throw new Error(`No config path defined for ${agent.name} with type ${connectorType}`);
  const resolvedPath = resolveAgentConfigPath(agent.id, connectorType, configPath, request);
  return agent.id === "omp"
    ? diagnoseOmpHooks(resolvedPath)
    : diagnoseCodexHooks(resolvedPath, options);
}
