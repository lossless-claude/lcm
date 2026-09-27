import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { installConnector, removeConnector, listConnectors } from '../../src/connectors/installer.js';
import { LCM_MARKERS } from '../../src/connectors/constants.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lcm-installer-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Claude Code uses rules (append mode) and skill
describe('installConnector — rules (markdown append)', () => {
  it('writes a rules file with LCM markers', () => {
    const result = installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    expect(result.success).toBe(true);
    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain(LCM_MARKERS.START);
    expect(content).toContain(LCM_MARKERS.END);
    expect(content).toContain('lcm search');
  });

  it('appends to existing file without marker duplication', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, '# My existing rules\n\nSome content here.\n');
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('# My existing rules');
    expect(content).toContain(LCM_MARKERS.START);
  });

  it('is idempotent — install twice, markers appear once', () => {
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const content = readFileSync(rulesPath, 'utf-8');
    const startCount = (content.match(new RegExp(LCM_MARKERS.START.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&'), 'g')) ?? []).length;
    expect(startCount).toBe(1);
  });

  it('returns requiresRestart: false for rules', () => {
    const result = installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    expect(result.requiresRestart).toBe(false);
  });
});

describe('installConnector — MCP JSON', () => {
  it('writes JSON with mcpServers.lcm', () => {
    const result = installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    expect(result.success).toBe(true);
    const config = JSON.parse(readFileSync(result.path, 'utf-8'));
    expect(config.mcpServers?.lcm).toBeDefined();
    // The entry must not depend on PATH resolving `lcm` or a shim's `node` shebang (#424):
    // command/args are absolute paths measured from the running installer process.
    expect(config.mcpServers.lcm.command).not.toBe('lcm');
    expect(config.mcpServers.lcm.command).not.toBe('node');
    expect(isAbsolute(config.mcpServers.lcm.command)).toBe(true);
    expect(config.mcpServers.lcm.args).toHaveLength(2);
    expect(isAbsolute(config.mcpServers.lcm.args[0])).toBe(true);
    expect(config.mcpServers.lcm.args[1]).toBe('mcp');
  });

  it('merges into existing JSON without overwriting other keys', () => {
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2));
    installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.lcm).toBeDefined();
  });

  it('is idempotent — install twice, lcm key appears once', () => {
    installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    const mcpPath = join(tmpDir, '.mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(Object.keys(config.mcpServers).filter(k => k === 'lcm').length).toBe(1);
  });

  it('returns requiresRestart: true for mcp', () => {
    const result = installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    expect(result.requiresRestart).toBe(true);
  });
});

describe('installConnector — skill', () => {
  it('creates SKILL.md in subdirectory', () => {
    const result = installConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir });
    expect(result.success).toBe(true);
    expect(result.path).toContain('lcm-memory');
    expect(result.path).toContain('SKILL.md');
    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain('lcm search');
    expect(content).toContain('lcm store');
  });

  it('does not add markers to skill file', () => {
    const result = installConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir });
    const content = readFileSync(result.path, 'utf-8');
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('returns requiresRestart: true for skill', () => {
    const result = installConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir });
    expect(result.requiresRestart).toBe(true);
  });
});

describe('installConnector — skill shared path (codex/github-copilot)', () => {
  it('writes codex skill to .agents/skills/lcm-memory/SKILL.md', () => {
    const result = installConnector({ agent: 'codex', type: 'skill', cwd: tmpDir });
    expect(result.path).toBe(join(tmpDir, '.agents', 'skills', 'lcm-memory', 'SKILL.md'));
    expect(existsSync(result.path)).toBe(true);
  });

  it('writes github-copilot skill to .agents/skills/lcm-memory/SKILL.md', () => {
    const result = installConnector({ agent: 'github-copilot', type: 'skill', cwd: tmpDir });
    expect(result.path).toBe(join(tmpDir, '.agents', 'skills', 'lcm-memory', 'SKILL.md'));
    expect(existsSync(result.path)).toBe(true);
  });

  it('removes a pre-existing legacy codex skill copy on install', () => {
    const legacyDir = join(tmpDir, '.codex', 'skills', 'lcm-memory');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), 'stale content');

    installConnector({ agent: 'codex', type: 'skill', cwd: tmpDir });

    expect(existsSync(join(legacyDir, 'SKILL.md'))).toBe(false);
    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(join(tmpDir, '.agents', 'skills', 'lcm-memory', 'SKILL.md'))).toBe(true);
  });

  it('removes a pre-existing legacy github-copilot skill copy on install', () => {
    const legacyDir = join(tmpDir, '.github', 'skills', 'lcm-memory');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), 'stale content');

    installConnector({ agent: 'github-copilot', type: 'skill', cwd: tmpDir });

    expect(existsSync(join(legacyDir, 'SKILL.md'))).toBe(false);
    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(join(tmpDir, '.agents', 'skills', 'lcm-memory', 'SKILL.md'))).toBe(true);
  });
});

describe('removeConnector — skill shared path (codex/github-copilot)', () => {
  it('removes both the current and legacy codex skill locations', () => {
    installConnector({ agent: 'codex', type: 'skill', cwd: tmpDir });
    const legacyDir = join(tmpDir, '.codex', 'skills', 'lcm-memory');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), 'stale content');

    const removed = removeConnector({ agent: 'codex', type: 'skill', cwd: tmpDir });

    expect(removed).toBe(true);
    expect(existsSync(join(tmpDir, '.agents', 'skills', 'lcm-memory', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(legacyDir, 'SKILL.md'))).toBe(false);
  });

  it('removes only a lingering legacy github-copilot copy when the new one is absent', () => {
    const legacyDir = join(tmpDir, '.github', 'skills', 'lcm-memory');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), 'stale content');

    const removed = removeConnector({ agent: 'github-copilot', type: 'skill', cwd: tmpDir });

    expect(removed).toBe(true);
    expect(existsSync(join(legacyDir, 'SKILL.md'))).toBe(false);
  });
});

describe('removeConnector — rules', () => {
  it('removes markers from existing rules file', () => {
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    const removed = removeConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    expect(removed).toBe(true);
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    // File deleted when empty, or content has no markers
    try {
      const content = readFileSync(rulesPath, 'utf-8');
      expect(content).not.toContain(LCM_MARKERS.START);
    } catch {
      // File was deleted — also acceptable
    }
  });

  it('preserves non-lcm content when removing markers', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, '# My Rules\n\nKeep this.\n');
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    removeConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('Keep this');
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('returns false when file does not exist', () => {
    const removed = removeConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    expect(removed).toBe(false);
  });

  it('returns false when markers not present', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, '# No markers here\n');
    const removed = removeConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    expect(removed).toBe(false);
  });
});

describe('removeConnector — MCP JSON', () => {
  it('removes mcpServers.lcm from JSON', () => {
    installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    const removed = removeConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    expect(removed).toBe(true);
    const mcpPath = join(tmpDir, '.mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers?.lcm).toBeUndefined();
  });

  it('returns false when file does not exist', () => {
    expect(removeConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir })).toBe(false);
  });

  it('returns false when lcm key not present', () => {
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));
    expect(removeConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir })).toBe(false);
  });
});

describe('removeConnector — skill', () => {
  it('removes SKILL.md', () => {
    const result = installConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir });
    const removed = removeConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir });
    expect(removed).toBe(true);
    expect(() => readFileSync(result.path, 'utf-8')).toThrow();
  });

  it('returns false when skill not installed', () => {
    expect(removeConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir })).toBe(false);
  });
});

describe('listConnectors', () => {
  it('finds installed rules connector', () => {
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    const list = listConnectors({ cwd: tmpDir });
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'rules');
    expect(found).toBeDefined();
  });

  it('finds installed MCP connector', () => {
    installConnector({ agent: 'claude-code', type: 'mcp', cwd: tmpDir });
    const list = listConnectors({ cwd: tmpDir });
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'mcp');
    expect(found).toBeDefined();
  });

  it('finds installed skill connector', () => {
    installConnector({ agent: 'claude-code', type: 'skill', cwd: tmpDir });
    const list = listConnectors({ cwd: tmpDir });
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'skill');
    expect(found).toBeDefined();
  });

  it('returns empty when nothing installed', () => {
    const list = listConnectors({ cwd: tmpDir });
    expect(list).toHaveLength(0);
  });

  it('does not list removed connectors', () => {
    installConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    removeConnector({ agent: 'claude-code', type: 'rules', cwd: tmpDir });
    const list = listConnectors({ cwd: tmpDir });
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'rules');
    expect(found).toBeUndefined();
  });
});

describe('error handling', () => {
  it('throws for unknown agent', () => {
    expect(() => installConnector({ agent: 'unknown-agent-xyz', type: 'rules', cwd: tmpDir })).toThrow('Unknown agent');
  });

  it('throws for unsupported connector type', () => {
    // Zed only supports rules and mcp, not skill
    expect(() => installConnector({ agent: 'zed', type: 'skill', cwd: tmpDir })).toThrow('does not support connector type');
  });

  it('returns manual instructions for hook type', () => {
    const result = installConnector({ agent: 'claude-code', type: 'hook', cwd: tmpDir });
    expect(result.manual).toBeDefined();
    expect(result.manual).toContain('Hook connectors');
  });
});
