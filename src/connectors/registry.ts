import type { Agent, AgentCategory } from './types.js';

export const AGENTS: Agent[] = [
  // CLI tools (7)
  {
    id: 'claude-code',
    name: 'Claude Code',
    category: 'cli',
    defaultType: 'skill',
    supportedTypes: ['rules', 'hook', 'mcp', 'skill'],
    configPaths: {
      rules: 'CLAUDE.md',
      hook: '~/.claude/settings.json',
      mcp: '.mcp.json',
      skill: '.claude/skills/',
    },
    writeMode: 'append',
  },
  {
    id: 'codex',
    name: 'Codex',
    category: 'cli',
    defaultType: 'skill',
    supportedTypes: ['rules', 'mcp', 'skill'],
    configPaths: {
      rules: 'AGENTS.md',
      mcp: '.codex/config.toml',
      skill: '.codex/skills/',
    },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    category: 'cli',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: 'GEMINI.md',
      skill: '.gemini/skills/',
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    category: 'cli',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.opencode/rules.md',
      skill: '.opencode/skills/',
    },
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    category: 'cli',
    defaultType: 'mcp',
    supportedTypes: ['rules', 'mcp'],
    configPaths: {
      rules: '.qwen/rules.md',
      mcp: '.qwen/mcp.json',
    },
  },
  {
    id: 'warp',
    name: 'Warp',
    category: 'cli',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.warp/rules.md',
      skill: '.warp/skills/',
    },
  },
  {
    id: 'auggie-cli',
    name: 'Auggie CLI',
    category: 'cli',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.auggie/rules.md',
      skill: '.auggie/skills/',
    },
  },

  // AI IDEs (6)
  {
    id: 'cursor',
    name: 'Cursor',
    category: 'ai-ide',
    defaultType: 'skill',
    supportedTypes: ['rules', 'mcp', 'skill'],
    configPaths: {
      rules: '.cursor/rules/lcm.mdc',
      mcp: '.cursor/mcp.json',
      skill: '.cursor/skills/',
    },
    header: '---\ndescription: lcm Memory\nalwaysApply: true\n---',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    category: 'ai-ide',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.windsurf/rules/lcm.md',
      skill: '.windsurf/skills/',
    },
    header: '---\ntrigger: always_on\n---',
  },
  {
    id: 'zed',
    name: 'Zed',
    category: 'ai-ide',
    defaultType: 'mcp',
    supportedTypes: ['rules', 'mcp'],
    configPaths: {
      rules: 'agent-context.rules',
      mcp: '.zed/settings.json',
    },
  },
  {
    id: 'trae',
    name: 'Trae.ai',
    category: 'ai-ide',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.trae/rules/lcm.md',
      skill: '.trae/skills/',
    },
  },
  {
    id: 'qoder',
    name: 'Qoder',
    category: 'ai-ide',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.qoder/rules/lcm.md',
      skill: '.qoder/skills/',
    },
    header: '---\ntrigger: always_on\nalwaysApply: true\n---',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    category: 'ai-ide',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.antigravity/rules.md',
      skill: '.antigravity/skills/',
    },
  },

  // VS Code Extensions (8)
  {
    id: 'cline',
    name: 'Cline',
    category: 'vscode-ext',
    defaultType: 'mcp',
    supportedTypes: ['rules', 'mcp'],
    configPaths: {
      rules: '.clinerules/lcm.md',
    },
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    category: 'vscode-ext',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.github/copilot-instructions.md',
      skill: '.github/skills/',
    },
    writeMode: 'append',
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    category: 'vscode-ext',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.roo/rules/lcm.md',
      skill: '.roo/skills/',
    },
  },
  {
    id: 'kilo-code',
    name: 'Kilo Code',
    category: 'vscode-ext',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.kilo/rules/lcm.md',
      skill: '.kilo/skills/',
    },
  },
  {
    id: 'augment-code',
    name: 'Augment Code',
    category: 'vscode-ext',
    defaultType: 'mcp',
    supportedTypes: ['rules', 'mcp'],
    configPaths: {
      rules: '.augment/rules.md',
    },
    header: '---\ntype: "always_apply"\n---',
  },
  {
    id: 'amp',
    name: 'Amp',
    category: 'vscode-ext',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.amp/rules/lcm.md',
      skill: '.amp/skills/',
    },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    category: 'vscode-ext',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.kiro/steering/lcm.md',
      skill: '.kiro/skills/',
    },
    header: '---\ninclusion: always\n---',
  },
  {
    id: 'junie',
    name: 'Junie',
    category: 'vscode-ext',
    defaultType: 'skill',
    supportedTypes: ['rules', 'skill'],
    configPaths: {
      rules: '.junie/rules/lcm.md',
      skill: '.junie/skills/',
    },
  },

  // Other (1)
  {
    id: 'openclaw',
    name: 'OpenClaw',
    category: 'other',
    defaultType: 'skill',
    supportedTypes: ['skill'],
    configPaths: {
      skill: '.openclaw/skills/',
    },
  },
];

export function findAgent(idOrName: string): Agent | undefined {
  const lower = idOrName.toLowerCase();
  return AGENTS.find(a => a.id === lower || a.name.toLowerCase() === lower);
}

export function getAgentsByCategory(category: AgentCategory): Agent[] {
  return AGENTS.filter(a => a.category === category);
}
