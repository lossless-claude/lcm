# lcm-context Skill: Multi-Platform Distribution

**Date:** 2026-03-23
**Status:** Draft
**Author:** Pedro + Claude

## Problem

lcm has 7 MCP tools but no guidance for agents on when to use each one, how to recover from errors, or when to store vs. skip curation. Claude Code has hooks for automatic memory injection; other platforms (Codex, Gemini, Cursor, OpenCode, Kiro, Zed) do not.

The result:
- Claude wastes tokens calling the wrong lcm tool
- Non-Claude platforms get no memory integration at all
- No self-healing when daemon is down or MCP disconnects

## Prior Art

### ByteRover
- Ships a single universal skill (`SKILL.md`) identical across `.claude/skills/` and `.agents/skills/`
- Uses "You MUST use this before any work" trigger to force invocation
- CLI-only interface (`brv query`/`brv curate`) — no platform-specific variants needed
- Decision trees: "Use when" / "Do NOT use when" per command
- Error tables: agent-fixable vs. user-fixable split
- Diagnosis: `brv status` one-liner

### context-mode
- Ships per-platform config files in `configs/` directory inside npm package
- Install step: `cp` from `node_modules` to platform-specific location
- Platform matrix with hooks (Claude Code, Gemini, Cursor, Kiro) vs. instruction-only (Codex, Zed, Antigravity)
- Hook-capable platforms get ~98% enforcement; instruction-only get ~60%
- Codex global path: `~/.codex/AGENTS.md` (applies to all projects)

### Cursor blog — Dynamic Context Discovery
- Skills are files with name+description in system prompt (static context)
- Agent pulls full skill content on demand (dynamic context)
- Files are the best abstraction for LLM context (validates both ByteRover and lcm's approach)

## Design

### Two Skill Variants

**Variant A: Claude Code (complementary to hooks)**

```
Description: "Use when deciding which lcm MCP tool to call — lcm_search,
lcm_grep, lcm_expand, lcm_describe, or lcm_store — or when an lcm tool
returns an error."
```

- Does NOT use "You MUST" — hooks already inject memory at session start
- Focuses on: tool decision tree, error self-healing, curation guidance
- References MCP tool names (lcm_search, lcm_grep, etc.)
- Written: `.claude-plugin/skills/lcm-context/SKILL.md` (ships with plugin)
- Also installed globally: `~/.claude/skills/lcm-context/SKILL.md` (via `lcm install`)

Contents:
1. **Tool Decision Tree** — when to use each of the 7 MCP tools
2. **Chaining Pattern** — search (broad) → grep (narrow) → describe (check) → expand (deep)
3. **When to Use / When NOT to Use** — guardrails for retrieval and storage
4. **Error Self-Healing** — agent-fixable vs. user-fixable error tables
5. **Quick Reference** — one-line per tool

**Variant B: Universal (primary memory interface)**

```
Description: "You MUST use this before any work to recall project memory,
and after implementing to store decisions. Lossless-claude (lcm) provides
persistent cross-session memory via CLI commands."
```

- Uses "You MUST" — no hooks on these platforms, skill is the only integration point
- Enforces workflow: query before work → implement → store after
- References CLI commands (lcm search, lcm grep, etc.) not MCP tool names
- Content adapted per platform's instruction file format

Contents:
1. **Workflow** — "Before Thinking: lcm search" / "After Implementing: lcm store"
2. **Commands** — same decision tree but with CLI syntax and examples
3. **Chaining Pattern** — search → grep → describe → expand
4. **When to Use / When NOT to Use** — same guardrails
5. **Error Self-Healing** — adapted for CLI errors (command not found, daemon not running)
6. **Quick Diagnosis** — `lcm doctor`, `lcm stats`

### Per-Platform Config Files

Shipped inside the npm package at `configs/<platform>/`:

| Platform | File | Global install path | Install method |
|---|---|---|---|
| Claude Code | `SKILL.md` | `~/.claude/skills/lcm-context/SKILL.md` | `lcm install` (auto) |
| Codex CLI | `AGENTS.md` | `~/.codex/AGENTS.md` | `lcm install --platform codex` |
| Gemini CLI | `GEMINI.md` | Injected at runtime via hook | `lcm install --platform gemini` |
| Cursor | `lcm-context.mdc` | `.cursor/rules/lcm-context.mdc` | `lcm install --platform cursor` |
| OpenCode | `AGENTS.md` | Per-project `AGENTS.md` | `lcm install --platform opencode` |
| Kiro | `KIRO.md` | Per-project `KIRO.md` | `lcm install --platform kiro` |
| Zed | `AGENTS.md` | Per-project `AGENTS.md` | `lcm install --platform zed` |

### Content Differences Per Platform

The core content (decision tree, guardrails, error tables) is identical across all platforms. The differences are:

| Aspect | Claude Code variant | Universal variant |
|---|---|---|
| Trigger | On-demand (no "You MUST") | Mandatory ("You MUST") |
| Tool references | MCP tool names (lcm_search) | CLI commands (lcm search) |
| Workflow enforcement | None (hooks handle it) | Explicit (query before, store after) |
| Hook-injected memory | "Don't re-query" note | Not mentioned |
| Error: MCP disconnected | "Restart session" | N/A (no MCP) |
| Error: command not found | N/A | "npm install -g @lossless-claude/lcm" |
| File format | SKILL.md (frontmatter) | AGENTS.md / GEMINI.md / .mdc (platform-native) |

### Install Flow

`lcm install` already writes hooks and MCP config. The skill becomes one more artifact:

```
lcm install
  ├── detects platform (Claude Code, Codex, Gemini, etc.)
  ├── writes MCP config (platform-specific)
  ├── writes hooks (if platform supports them)
  └── writes skill/instruction file (NEW)
       ├── Claude Code → ~/.claude/skills/lcm-context/SKILL.md
       ├── Codex → appends to ~/.codex/AGENTS.md
       ├── Gemini → configures runtime injection
       ├── Cursor → .cursor/rules/lcm-context.mdc
       └── others → project-level instruction file
```

For platforms that use `AGENTS.md` (Codex, OpenCode, Zed), lcm appends its section with a clear delimiter:

```markdown
<!-- lcm-context: start -->
## lcm Memory Guide
...
<!-- lcm-context: end -->
```

This allows `lcm install` to update the section idempotently without clobbering user content.

### Integration with Existing Connector Registry

lcm already has a 22-platform connector registry with templated install (`src/connectors/`). Each connector defines:
- MCP config format
- Hook format (if supported)
- Config file paths

Adding a `skillTemplate` or `instructionFile` field per connector extends the registry naturally:

```typescript
interface ConnectorConfig {
  // ... existing fields
  instructionFile?: {
    path: string           // e.g., "~/.codex/AGENTS.md"
    format: 'skill' | 'agents-md' | 'gemini-md' | 'mdc'
    append: boolean        // true for AGENTS.md (append with delimiters)
    global: boolean        // true for ~/.codex/, false for per-project
  }
}
```

## What This Does NOT Cover

- **MCP server registration per platform** — already handled by `lcm install`
- **Hook configuration** — already handled by `lcm install`
- **Auto-curation on session end** — SessionEnd is unreliable (only fires on `/exit`); curation guidance in the skill is sufficient
- **ByteRover-style cloud sync** — not in scope for lcm

## Resolved Questions

1. **CLI > MCP for universal variant.** CLI commands work on every platform without MCP setup. Simpler to document, easier to debug. MCP tools are Claude Code-only in practice.

2. **Gemini: GEMINI.md file for now.** Gemini CLI supports hooks (SessionStart could inject at runtime, like context-mode does), but lcm's skill is just guidance text — a GEMINI.md file is sufficient. If lcm later adds Gemini hook support for compaction/restore, skill injection can ride along for free.

3. **HTML comment delimiters for AGENTS.md.** `<!-- lcm-context: start -->` / `<!-- lcm-context: end -->` for idempotent append/update without clobbering user content.

## Success Criteria

- Claude Code users: Claude picks the right lcm tool on first try (not lcm_search when lcm_grep is better)
- Codex/Gemini users: lcm memory is queried before work and stored after, without manual prompting
- All platforms: agent self-heals from daemon-down errors without asking the user
- `lcm install` writes the skill file automatically for the detected platform
