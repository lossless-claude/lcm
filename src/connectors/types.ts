export const CONNECTOR_TYPES = ['rules', 'hook', 'hooks', 'mcp', 'skill'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export type AgentCategory = 'cli' | 'ai-ide' | 'vscode-ext' | 'other';

/**
 * A kind of memory guidance an agent receives: the learning instruction (when to
 * store, how to report use and vote), the standing memory rules, or the tools.
 */
export type GuidanceSurface = 'learning-instruction' | 'memory-rules' | 'tools';

export interface GuidanceDelivery {
  surface: GuidanceSurface;
  /** The connector type that delivers it, or `lcm-md` for Claude Code's ~/.claude/lcm.md. */
  via: ConnectorType | 'lcm-md';
  /** `lcm install` does not set it up; the user adds it by hand. */
  manual?: true;
}

export interface Agent {
  id: string;
  name: string;
  category: AgentCategory;
  defaultType: ConnectorType;
  supportedTypes: ConnectorType[];
  configPaths: Partial<Record<ConnectorType, string>>;
  writeMode?: 'append' | 'overwrite'; // default: 'overwrite'
  header?: string; // YAML frontmatter for rules files
  /** What `lcm install` teaches this harness's agent, each row checked by `lcm doctor`. Native harnesses only. */
  guidance?: GuidanceDelivery[];
}

/**
 * Whether the connector type requires an agent restart to take effect.
 * Rules connectors are passive (agent reads on each prompt).
 * Hook, MCP, and skill connectors need restart.
 */
export function requiresRestart(type: ConnectorType): boolean {
  return type !== 'rules';
}
