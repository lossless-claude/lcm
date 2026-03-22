import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, ConnectorType } from "./types.js";
import { LCM_MARKERS, LCM_TAG } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

function loadFile(path: string): string {
  return readFileSync(join(TEMPLATES_DIR, path), "utf-8");
}

function substituteVariables(template: string, context: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function wrapWithMarkers(content: string, agentName: string, header?: string): string {
  const parts: string[] = [];
  if (header) parts.push(header);
  parts.push(LCM_MARKERS.START);
  parts.push(content);
  parts.push('---');
  parts.push(`${LCM_TAG} ${agentName}`);
  parts.push(LCM_MARKERS.END);
  return parts.join('\n');
}

export function generateRulesContent(agent: Agent): string {
  const workflow = loadFile("sections/workflow.md");
  const commandRef = loadFile("sections/command-reference.md");
  const base = loadFile("base.md");
  const content = substituteVariables(base, {
    workflow: substituteVariables(workflow, { command_reference: commandRef }),
  });
  return wrapWithMarkers(content, agent.name, agent.header);
}

export function generateMcpContent(agent: Agent): string {
  const mcpWorkflow = loadFile("sections/mcp-workflow.md");
  const base = loadFile("mcp-base.md");
  const content = substituteVariables(base, { mcp_workflow: mcpWorkflow });
  return wrapWithMarkers(content, agent.name, agent.header);
}

export function generateSkillContent(_agent: Agent): string {
  return loadFile("skill/SKILL.md"); // Skills don't need markers — they're standalone files
}

export function generateContent(agent: Agent, type: ConnectorType): string {
  switch (type) {
    case 'rules': return generateRulesContent(agent);
    case 'mcp': return generateMcpContent(agent);
    case 'skill': return generateSkillContent(agent);
    case 'hook': throw new Error('Hook connectors are managed by the plugin system, not the template service');
  }
}
