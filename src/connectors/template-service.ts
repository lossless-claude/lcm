import type { Agent, ConnectorType } from "./types.js";
import { LCM_MARKERS, LCM_TAG } from "./constants.js";
import { RULES_CLI, RULES_MCP, SKILL } from "../guidance.js";

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
  return wrapWithMarkers(RULES_CLI, agent.name, agent.header);
}

export function generateMcpContent(agent: Agent): string {
  return wrapWithMarkers(RULES_MCP, agent.name, agent.header);
}

export function generateSkillContent(_agent: Agent): string {
  return SKILL; // Skills don't need markers — they're standalone files
}

export function generateContent(agent: Agent, type: ConnectorType): string {
  switch (type) {
    case 'rules': return generateRulesContent(agent);
    case 'mcp': return generateMcpContent(agent);
    case 'skill': return generateSkillContent(agent);
    case 'hook': throw new Error('Hook connectors are managed by the plugin system, not the template service');
    case 'hooks': throw new Error('Native hook connectors are managed by the connector installer, not the template service');
  }
}
