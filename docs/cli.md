# CLI Reference

The `lcm` command-line tool provides direct access to all lossless-claude operations from the terminal.

```
lcm — lossless context management for Claude Code

Usage: lcm <command> [options]
```

## Setup

### lcm install

Register hooks, configure daemon, and connect MCP server.

```bash
lcm install [--dry-run]
```

Creates `~/.lossless-claude/config.json`, registers lifecycle hooks in `~/.claude/settings.json`, configures the MCP server, and starts the background daemon.

### lcm uninstall

Remove hooks and MCP registration.

```bash
lcm uninstall [--dry-run]
```

## Runtime

### lcm daemon start

Start the context daemon.

```bash
lcm daemon start [--detach]
```

The daemon runs the MCP server and handles memory operations. Use `--detach` to run in background.

### lcm status

Daemon status and project memory stats.

```bash
lcm status [--json]
```

### lcm doctor

Run diagnostics: daemon, hooks, MCP, and summarizer health.

```bash
lcm doctor
```

### lcm mcp

Start the MCP server on stdio transport. Used internally by Claude Code's MCP configuration.

```bash
lcm mcp
```

## Memory

### lcm compact

Compact conversations into DAG summaries.

```bash
lcm compact [--all] [--dry-run] [--replay] [--no-promote]
```

| Flag | Description |
|------|-------------|
| `--all` | Compact all projects |
| `--dry-run` | Preview without writing |
| `--replay` | Re-compact sessions that already have summaries |
| `--no-promote` | Skip automatic promotion after compaction |

### lcm import

Import session transcripts (Claude Code or Codex CLI).

```bash
lcm import [--provider claude|codex|all] [--all] [--verbose] [--dry-run] [--replay]
```

| Flag | Description |
|------|-------------|
| `--provider` | Which CLI's transcripts to import (`claude`, `codex`, or `all`) |
| `--all` | Import all projects |
| `--verbose` | Show per-session details |
| `--dry-run` | Preview without writing |
| `--replay` | Re-import chronologically with inline compaction |

### lcm promote

Promote insights to long-term memory.

```bash
lcm promote [--all] [--verbose] [--dry-run]
```

### lcm stats

Memory inventory and compression ratios.

```bash
lcm stats [-v]
```

### lcm diagnose

Scan sessions for hook failures and issues.

```bash
lcm diagnose [--all] [--days N] [--verbose] [--json]
```

## Connectors

Manage integrations with other AI coding agents (Codex CLI, OpenCode, Gemini CLI).

### lcm connectors list

```bash
lcm connectors list [--format text|json]
```

### lcm connectors install

```bash
lcm connectors install <agent> [--type ...]
```

### lcm connectors remove

```bash
lcm connectors remove <agent> [--type ...]
```

### lcm connectors doctor

```bash
lcm connectors doctor [agent]
```

## Sensitive

### lcm sensitive list

List active redaction patterns (built-in, global, and project-specific).

```bash
lcm sensitive list
```

### lcm sensitive add

Add a redaction pattern.

```bash
lcm sensitive add <pattern>
lcm sensitive add --global <pattern>
```

### lcm sensitive remove

Remove a redaction pattern.

```bash
lcm sensitive remove <pattern>
```

### lcm sensitive test

Test text against active patterns.

```bash
lcm sensitive test <text>
```

### lcm sensitive purge

Delete project data (requires `--yes` confirmation).

```bash
lcm sensitive purge [--all] --yes
```

## Hooks (internal)

These commands are called by Claude Code lifecycle hooks. They are not intended for direct user invocation.

| Command | Hook | Purpose |
|---------|------|---------|
| `lcm restore` | SessionStart | Restore prior context |
| `lcm session-end` | SessionEnd | Finalize and store session memory |
| `lcm user-prompt` | UserPromptSubmit | Record user prompt context |
| `lcm post-tool` | PostToolUse | Capture tool events |

## Global flags

| Flag | Description |
|------|-------------|
| `-V, --version` | Show version |
| `-h, --help` | Show help |
