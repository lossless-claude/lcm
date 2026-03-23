# CLI Refactor — Design Spec

**Date:** 2026-03-21
**Status:** Draft
**Depends on:** [CLI-First Connectors Design](2026-03-21-cli-first-connectors-design.md)

## Context

lossless-claude wraps Codex via `lossless-codex` binary, but this wrapper doesn't expose the native TUI, making it useless for real coding. ByteRover validated the CLI-first + connector approach: move memory to a standalone CLI and use per-agent connectors to teach agents how to call it. This spec implements that shift for lossless-claude.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Remove codex wrapper | Yes | Wrapper hides TUI, no value |
| Rename binary | `lossless-claude` → `lcm` | Shorter, matches MCP prefix |
| Data directory | Keep `~/.lossless-claude/` | No migration needed |
| Platform coverage | 22 agents (match ByteRover/brv) | Proven market coverage |
| Connector types | rules, hook, mcp, skill | ByteRover's proven model |
| Agent registry format | TypeScript in `src/connectors/` | Type-safe, compile-time checks |
| Install behavior | Auto-write files | Match ByteRover UX |
| Claude Code connector | Skill default, hooks via plugin | Complementary — skill for instructions, hooks for lifecycle |
| Template format | Markdown sections + `{{var}}` substitution | Simple, proven in ByteRover |
| Release strategy | Parallel tracks | Breaking changes isolated from additive work |

## Track 1 — Breaking Changes (v1.0.0)

### PR A: Remove lossless-codex wrapper

**Delete:**
- `bin/lossless-codex.ts`
- `src/adapters/codex.ts`
- `test/adapters/codex.test.ts`
- `test/fixtures/codex/`

**Edit:**
- `package.json` — remove `"lossless-codex"` from `bin`

**Keep (summarizer backend):**
- `src/llm/codex-process.ts`
- `test/llm/codex-process.test.ts`

**Audit for stale codex refs:**
- `test/summarize.test.ts`
- `test/doctor/doctor.test.ts`
- `test/daemon/config.test.ts`
- `test/daemon/routes/ingest.test.ts`
- `test/daemon/routes/compact.test.ts`

### PR B: Rename binary to `lcm` + migration

**Rename:**
- `bin/lossless-claude.ts` → `bin/lcm.ts`

**Upgrade migration** (in `installer/install.ts`):
- On `lcm install`, scan `~/.claude/settings.json` for old `lossless-claude` hook commands and MCP entries
- Rewrite `lossless-claude compact` → `lcm compact` (etc.) in-place
- Rewrite `mcpServers.lossless-claude` → `mcpServers.lcm`
- Auto-heal already fires on every hook entry point — wire migration into the same path so whichever hook fires first migrates old entries

**Codebase-wide rename** (`lossless-claude` → `lcm` in CLI/binary contexts):

42 files reference `lossless-claude`. The rename is a search-and-replace scoped to binary/CLI name contexts (NOT the data directory `~/.lossless-claude/` or npm package name).

Key structural edits:
- `package.json` bin: `"lcm": "dist/bin/lcm.js"`
- `installer/install.ts:6` — **`REQUIRED_HOOKS` constant** (source of truth for all hook commands)
- `installer/uninstall.ts` — uses `REQUIRED_HOOKS` for cleanup
- `installer/dry-run-deps.ts` — binary name references
- `.claude-plugin/plugin.json` — 4 hook commands + MCP server command
- `.claude-plugin/commands/lossless-claude-doctor.md` → `lcm-doctor.md` (rename file)
- `.claude-plugin/commands/lossless-claude-stats.md` → `lcm-stats.md` (rename file)

Source files with binary name in strings/logs (26 files):
- `src/hooks/auto-heal.ts`, `dispatch.ts`, `compact.ts`, `restore.ts`, `user-prompt.ts`, `session-end.ts`, `probe-precompact.ts`, `probe-sessionstart.ts`
- `src/daemon/server.ts`, `config.ts`, `orientation.ts`, `project.ts`, `proxy-manager.ts`, `routes/compact.ts`
- `src/doctor/doctor.ts` — includes MCP handshake self-test path (`bin/lossless-claude.js`)
- `src/mcp/server.ts` — MCP server name
- `src/mcp/tools/lcm-stats.ts`, `lcm-store.ts`, `lcm-doctor.ts`
- `src/db/config.ts`
- `src/stats.ts`

Test files (16 files):
- `test/installer/install.test.ts`, `uninstall.test.ts`, `dry-run-deps.test.ts`
- `test/hooks/auto-heal.test.ts`, `dispatch.test.ts`
- `test/doctor/doctor.test.ts`, `doctor-hooks.test.ts`
- `test/daemon/routes/compact.test.ts`, `lifecycle.test.ts`, `project.test.ts`
- `test/stats.test.ts`, `package-config.test.ts`, `fts-fallback.test.ts`, `migration.test.ts`, `db/promoted.test.ts`
- `test/adapters/codex.test.ts` (deleted in PR A)

**Strategy:** Global find-replace of `lossless-claude` in command/binary contexts, then manually verify each `~/.lossless-claude/` data dir reference is preserved.

**Keep unchanged:**
- `~/.lossless-claude/` data directory path (all occurrences)
- npm package name `@ipedro/lossless-claude`
- `src/llm/codex-process.ts` — any "lossless-claude" in error messages should become "lcm"

### PR C: Update docs and plugin metadata

- `README.md` — all CLI references
- `.claude-plugin/plugin.json` version bump
- `.claude-plugin/commands/*.md` — command references
- `.claude-plugin/hooks/README.md` — binary references
- `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md` — update `lossless-claude` → `lcm` in recovery instructions
- Changeset file for v1.0.0 release notes

## Track 2 — Connector System (v1.1.0)

### PR D: Agent types + registry

**New files:**

`src/connectors/types.ts`:
```typescript
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

export function requiresRestart(type: ConnectorType): boolean;
```

`src/connectors/registry.ts` — 22 agents:

| Category | Agents | Default | Notes |
|----------|--------|---------|-------|
| cli | Claude Code | skill | hook via plugin system |
| cli | Codex | skill | `.codex/config.toml` for MCP |
| cli | Gemini CLI | skill | |
| cli | OpenCode | skill | |
| cli | Qwen Code | mcp | |
| cli | Warp | skill | |
| cli | Auggie CLI | skill | |
| ai-ide | Cursor | skill | `.cursor/rules/lcm.mdc` |
| ai-ide | Windsurf | skill | `.windsurf/rules/lcm.md` |
| ai-ide | Zed | mcp | `agent-context.rules` for rules |
| ai-ide | Trae.ai | skill | |
| ai-ide | Qoder | skill | |
| ai-ide | Antigravity | skill | |
| vscode-ext | Cline | mcp | `.clinerules/lcm.md` for rules |
| vscode-ext | GitHub Copilot | skill | `.github/copilot-instructions.md` (append) |
| vscode-ext | Roo Code | skill | |
| vscode-ext | Kilo Code | skill | |
| vscode-ext | Augment Code | mcp | |
| vscode-ext | Amp | skill | |
| vscode-ext | Kiro | skill | `.kiro/steering/lcm.md` |
| vscode-ext | Junie | skill | |
| other | OpenClaw | skill | skill only |

`src/connectors/constants.ts`:
```typescript
export const LCM_MARKERS = {
  START: '<!-- [LCM_CONNECTOR_START] -->',
  END: '<!-- [LCM_CONNECTOR_END] -->',
} as const;

export const LCM_TAG = '@lcm';
```

### PR E: Template service + installer

**New files:**

`src/connectors/template-service.ts`:
- `TemplateLoader` class: loads templates from `src/connectors/templates/`
  - `loadTemplate(path)` — loads base template
  - `loadSection(name)` — loads from `sections/{name}.md`
  - `substituteVariables(template, context)` — replaces `{{key}}` with values
- `RuleTemplateService` class: generates content per connector type
  - `generateRuleContent(agent, type)` → CLI or MCP content with boundary markers
  - `generateCliContent(agent)` → base.md + sections composed
  - `generateMcpContent()` → mcp-base.md + mcp sections
- Per-agent YAML headers: Cursor, Windsurf, Kiro, Augment Code, Qoder

`src/connectors/templates/` structure:
```
templates/
├── base.md                    # "{{workflow}}"
├── mcp-base.md                # "{{mcp_workflow}}"
├── skill/
│   └── SKILL.md               # Full knowledge management skill (see below)
└── sections/
    ├── workflow.md             # CLI-mode core rules
    ├── mcp-workflow.md         # MCP-mode tool usage rules
    ├── lcm-instructions.md     # When to search/store decision tree
    └── command-reference.md    # lcm CLI command reference
```

**Template content:**

`sections/workflow.md` — CLI mode:
- Intro: "You are a coding agent. Use the lcm CLI to manage persistent memory."
- Core rules: search first, store what matters
- References lcm-instructions and command-reference

`sections/mcp-workflow.md` — MCP mode:
- Intro: "You are a coding agent integrated with lossless-claude via MCP."
- Core rules: use lcm_search tool first, lcm_store after work

`sections/lcm-instructions.md` — Decision tree:
- When to search: code tasks, understanding codebase, debugging, architectural decisions
- When to store: completed features, decisions, bug fixes, non-obvious discoveries
- When to skip: general knowledge, meta tasks, git operations
- Quick reference table (search? / store? per task type)

`sections/command-reference.md`:
- `lcm search "query"` — FTS5 search across memory
- `lcm grep "pattern"` — regex search across conversations
- `lcm expand "topic"` — expand on a memory topic
- `lcm describe` — show memory metadata
- `lcm store "content"` — persist to promoted memory
- `lcm stats` — compression ratios and token savings
- `lcm doctor` — run diagnostics

`skill/SKILL.md` — Full skill connector template:
- YAML frontmatter: `name: lcm-memory`, description
- Stop banner: "Code task? → lcm search FIRST"
- Workflow diagram: search → work → store → done
- 6 commands with detailed use/don't-use guidance
- Decision table (11 task types × search/store)
- Error handling section (not found, daemon down, empty memory)

**Installer:**

`src/connectors/installer.ts` — **two install strategies** by target format:

**Strategy 1: Markdown targets** (rules, skill connectors):
- Wrap content with `LCM_MARKERS.START` / `LCM_MARKERS.END`
- Write: append (CLAUDE.md, copilot-instructions.md) or overwrite (others)
- Remove: scan for boundary markers, strip markers + content

**Strategy 2: Structured targets** (MCP connectors — JSON/TOML):
- JSON targets (`.mcp.json`, `.cursor/mcp.json`, `.zed/settings.json`): parse, merge `mcpServers.lcm` key, write back
- TOML targets (`.codex/config.toml`): emit manual instructions (avoid new dep)
- VS Code settings (Cline, Augment Code): emit manual instructions (complex nested settings)
- Remove: delete `mcpServers.lcm` key from parsed structure

**Hook connectors** (Claude Code only): handled by existing `installer/install.ts` deep merge into `~/.claude/settings.json`. Not part of connector installer — hooks come via plugin system.

Functions:
- `installConnector(agent, type, cwd)`:
  1. Resolve agent from registry
  2. Select strategy by target format
  3. Generate content (markdown) or config entry (structured)
  4. Write to agent's config path (relative to cwd for workspace-local)
  5. Return `{ success, path, requiresRestart, manual?: string }`
- `removeConnector(agent, type, cwd)`:
  1. Markdown: find/strip boundary markers
  2. Structured: parse, delete key, write back
  3. Clean up empty files
- `listConnectors(cwd)`:
  1. Scan each agent's config paths (relative to cwd)
  2. Markdown: check for boundary markers
  3. Structured: check for `mcpServers.lcm` key
  4. Return installed agents with their connector types

**No state file** — filesystem scan is the single source of truth. Handles multi-workspace naturally (scan is always relative to cwd). No state drift possible.

### PR F: CLI commands

Add to `bin/lcm.ts` switch statement:

```typescript
case "connectors": {
  const sub = argv[3]; // list | install | remove | doctor
  switch (sub) {
    case "list":
      // List all available + installed connectors
      // --format text|json
      break;
    case "install":
      // argv[4] = agent name, --type flag optional
      break;
    case "remove":
      // argv[4] = agent name, --type flag optional
      break;
    case "doctor":
      // argv[4] = agent name (optional)
      // Validate connector health for one or all agents
      break;
    default:
      // Show connectors help
  }
  break;
}
```

No CLI framework — reuse existing raw switch pattern.

Output format for `lcm connectors list`:
```
Available agents     Installed       Default         Supported
──────────────────── ─────────────── ─────────────── ──────────────────────
Claude Code          skill           skill           rules, hook, mcp, skill
Cursor               -               skill           rules, mcp, skill
...
```

### PR G: Per-platform connector configs

Complete the registry with validated per-agent details:
- Config paths for each platform (rules file, MCP config, skill directory)
- Write modes (append vs overwrite)
- YAML headers for frontmatter-aware platforms
- MCP server configs (command, args, config file format)

Per-agent MCP configs:

| Agent | Config Path | Format |
|-------|-------------|--------|
| Claude Code | `.mcp.json` | JSON, `type: "stdio"` |
| Cursor | `.cursor/mcp.json` | JSON |
| Codex | `.codex/config.toml` | TOML |
| Cline | VS Code settings | JSON (manual) |
| Augment Code | VS Code settings | JSON (manual) |
| Zed | `.zed/settings.json` | JSON |
| Qwen Code | `.qwen/mcp.json` | JSON |

MCP server entry:
```json
{
  "lcm": {
    "type": "stdio",
    "command": "lcm",
    "args": ["mcp"]
  }
}
```

## Testing Strategy

| Area | Test Type | Files |
|------|-----------|-------|
| Registry | Unit | `test/connectors/registry.test.ts` — all 22 agents have required fields, configPaths match supportedTypes |
| Template service | Unit + snapshot | `test/connectors/template-service.test.ts` — each type generates correct content |
| Installer | Unit (mocked FS) | `test/connectors/installer.test.ts` — write/remove with markers, append vs overwrite, idempotency |
| CLI commands | Integration | `test/connectors/cli.test.ts` — list, install, remove with mocked FS |
| Codex removal | Regression | Existing test suite passes after cleanup |
| Rename | Regression | Binary resolves as `lcm`, hooks use correct command |

## Verification

### Track 1
```bash
# After PR A: codex removal
npm test                                    # All tests pass
node dist/bin/lossless-codex.js 2>&1       # Should fail (binary gone)

# After PR B: rename
npm run build
node dist/bin/lcm.js --version             # Shows version
node dist/bin/lcm.js doctor                # Runs diagnostics
node dist/bin/lcm.js daemon start          # Daemon starts

# After PR C: plugin update
cat .claude-plugin/plugin.json | grep lcm  # All hooks use 'lcm' command
```

### Track 2
```bash
# After PR D: registry
npx vitest run test/connectors/

# After PR E+F: install flow
node dist/bin/lcm.js connectors list
node dist/bin/lcm.js connectors install Cursor
cat .cursor/rules/lcm.mdc                 # Verify content with markers
node dist/bin/lcm.js connectors remove Cursor
cat .cursor/rules/lcm.mdc 2>&1            # Should be gone or empty

# After PR G: all platforms
node dist/bin/lcm.js connectors list --format json | jq '.agents | length'  # 22
```

## Files Summary

### New files (Track 2)
- `src/connectors/types.ts`
- `src/connectors/registry.ts`
- `src/connectors/constants.ts`
- `src/connectors/template-service.ts`
- `src/connectors/installer.ts`
- `src/connectors/templates/base.md`
- `src/connectors/templates/mcp-base.md`
- `src/connectors/templates/skill/SKILL.md`
- `src/connectors/templates/sections/workflow.md`
- `src/connectors/templates/sections/mcp-workflow.md`
- `src/connectors/templates/sections/lcm-instructions.md`
- `src/connectors/templates/sections/command-reference.md`
- `test/connectors/registry.test.ts`
- `test/connectors/template-service.test.ts`
- `test/connectors/installer.test.ts`
- `test/connectors/cli.test.ts`

### Deleted files (Track 1)
- `bin/lossless-codex.ts`
- `src/adapters/codex.ts`
- `test/adapters/codex.test.ts`
- `test/fixtures/codex/`

### Modified files (Track 1)
- `bin/lossless-claude.ts` → `bin/lcm.ts` (renamed + connectors command added)
- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/commands/lossless-claude-doctor.md` → `lcm-doctor.md`
- `.claude-plugin/commands/lossless-claude-stats.md` → `lcm-stats.md`
- `.claude-plugin/hooks/README.md`
- `installer/install.ts` (REQUIRED_HOOKS + binary refs)
- `installer/uninstall.ts`
- `installer/dry-run-deps.ts`
- 26 source files with binary name in strings/logs (see PR B for full list)
- 16 test files with binary name references
- `README.md`

## What stays unchanged
- Daemon, all routes, SQLite backend
- MCP server and all lcm_* tools
- Hook dispatch + auto-heal system
- Summarization pipeline (including codex-process.ts)
- `~/.lossless-claude/` data directory
- npm package name `@ipedro/lossless-claude`
