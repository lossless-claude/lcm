import { describe, it, expect } from 'vitest';
import { generateRulesContent, generateMcpContent, generateSkillContent, generateContent } from '../../src/connectors/template-service.js';
import { LCM_MARKERS } from '../../src/connectors/constants.js';
import type { Agent } from '../../src/connectors/types.js';

const mockAgent: Agent = {
  id: 'test-agent',
  name: 'Test Agent',
  category: 'cli',
  defaultType: 'rules',
  supportedTypes: ['rules', 'mcp', 'skill'],
  configPaths: {
    rules: 'TEST.md',
    mcp: '.test/mcp.json',
    skill: '.test/skills/',
  },
};

const mockAgentWithHeader: Agent = {
  ...mockAgent,
  header: '---\ntrigger: always_on\n---',
};

describe('generateRulesContent', () => {
  it('contains lcm search command', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain('lcm search');
  });

  it('contains LCM_MARKERS.START', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.START);
  });

  it('contains LCM_MARKERS.END', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.END);
  });

  it('contains agent name tag', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain('Test Agent');
  });

  it('substitutes all template variables (no {{}} placeholders remain)', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('includes header when agent has one', () => {
    const content = generateRulesContent(mockAgentWithHeader);
    expect(content).toContain('trigger: always_on');
  });

  it('does not include header when agent has none', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).not.toContain('trigger:');
  });

  it('contains command reference section', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain('lcm store');
    expect(content).toContain('lcm doctor');
  });
});

describe('generateMcpContent', () => {
  it('contains lcm_search MCP tool', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain('lcm_search');
  });

  it('contains LCM_MARKERS.START', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.START);
  });

  it('contains LCM_MARKERS.END', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.END);
  });

  it('substitutes all template variables', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('contains lcm_store tool', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain('lcm_store');
  });
});

describe('generateSkillContent', () => {
  it('contains lcm search command', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('lcm search');
  });

  it('contains lcm store command', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('lcm store');
  });

  it('does not contain LCM start marker (standalone file)', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('does not contain LCM end marker (standalone file)', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).not.toContain(LCM_MARKERS.END);
  });

  it('contains YAML frontmatter', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('name: lcm-memory');
  });
});

describe('generateContent dispatch', () => {
  it('delegates rules to generateRulesContent', () => {
    const content = generateContent(mockAgent, 'rules');
    expect(content).toContain(LCM_MARKERS.START);
    expect(content).toContain('lcm search');
  });

  it('delegates mcp to generateMcpContent', () => {
    const content = generateContent(mockAgent, 'mcp');
    expect(content).toContain('lcm_search');
  });

  it('delegates skill to generateSkillContent', () => {
    const content = generateContent(mockAgent, 'skill');
    expect(content).toContain('lcm store');
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('throws for hook type', () => {
    expect(() => generateContent(mockAgent, 'hook')).toThrow('Hook connectors are managed by the plugin system');
  });
});
