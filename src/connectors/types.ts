export const CONNECTOR_TYPES = ['rules', 'hook', 'mcp', 'skill'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export type AgentCategory = 'cli' | 'ai-ide' | 'vscode-ext' | 'other';

export interface Agent {
  id: string;
  name: string;
  category: AgentCategory;
  defaultType: ConnectorType;
  supportedTypes: ConnectorType[];
  configPaths: Partial<Record<ConnectorType, string>>;
  writeMode?: 'append' | 'overwrite'; // default: 'overwrite'
  header?: string; // YAML frontmatter for rules files
}

/**
 * Whether the connector type requires an agent restart to take effect.
 * Rules connectors are passive (agent reads on each prompt).
 * Hook, MCP, and skill connectors need restart.
 */
export function requiresRestart(type: ConnectorType): boolean {
  return type !== 'rules';
}
