# CLI Help & Progress Feedback — Design Spec

**Date:** 2026-03-23
**Status:** Approved
**Related:** Issue #36 (Commander.js migration, future)

---

## Problem

The `lcm` CLI has two UX gaps:

1. **No discoverable help.** Running `lcm --help` or an unknown command prints a single-line error listing all 18 command names with no descriptions. `lcm <command> --help` silently ignores the flag.
2. **Silent blocking operations.** Commands that connect to the daemon (`promote`, `import`, `compact`) wait up to 5s with no output before printing results.

---

## Approach

Data-driven help module + progress helpers. The existing switch-case dispatcher in `bin/lcm.ts` is preserved. All changes are additive.

No CLI framework migration. Commander.js migration tracked in issue #36.

---

## Architecture

### New files

**`src/cli/help.ts`**
- Defines all command help as structured data (`CommandDef[]`)
- Exports `printHelp()` (grouped command list) and `printCommandHelp(name)` (per-command detail)
- Renders with color when stdout is a TTY; plain text otherwise
- Uses `picocolors` for color

**`src/cli/ui.ts`**
- Exports `step`, `done`, `fail`, `warn`, `info` helpers
- All respect TTY: colored on terminal, plain when piped
- `step`/`fail`/`warn` write to stderr; `done`/`info` write to stdout

### Modified files

**`bin/lcm.ts`**
- Add early `--help`/`help` handling before the switch (checks `argv[2] === '--help'`, `argv[2] === 'help'`, and `argv[3] === '--help'`)
- Replace `default:` case error with `printHelp()` + exit(1)
- Add `step()`/`done()`/`fail()` calls to `promote`, `import`, `compact`
- Replace scattered `console.error(...)` in error paths with `fail(...)`

**`package.json`**
- Add `picocolors` dependency (~1.1KB, zero transitive deps)

---

## Help System

### `lcm --help` / `lcm help`

```
lossless-claude memory system

Usage: lcm <command> [options]

Setup
  install          Install hooks and MCP server configuration
  uninstall        Remove hooks and configuration
  connectors       Manage AI agent connectors (list|install|remove|doctor)

Daemon
  daemon start     Start the memory daemon
  status           Show daemon and project memory status
  doctor           Run health checks on all components

Memory
  compact          Compact conversation history into summaries
  import           Import Claude Code session transcripts
  promote          Promote insights to long-term memory
  stats            Show memory inventory and compression ratios

Diagnostics
  diagnose         Scan transcripts for hook failures and errors
  sensitive        Manage sensitive data redaction patterns

Run 'lcm help <command>' for flags and examples.
```

Hook commands (`restore`, `session-end`, `user-prompt`, `mcp`) are omitted from the grouped list — they are invoked automatically by Claude Code, not by users directly. They still respond to `--help` if called manually.

### Per-command help (`lcm help <cmd>` / `lcm <cmd> --help`)

#### `lcm help daemon`
```
Start and manage the memory daemon

Usage:
  lcm daemon start [--detach]

Subcommands:
  start    Start the daemon process

Options:
  --detach    Run the daemon in the background

Examples:
  lcm daemon start           Start in foreground (logs to stdout)
  lcm daemon start --detach  Start as a background process
```

#### `lcm help install`
```
Install hooks and MCP server configuration

Usage:
  lcm install [--dry-run]

Options:
  --dry-run    Preview changes without writing anything

Examples:
  lcm install            Install everything
  lcm install --dry-run  Preview what would be installed
```

#### `lcm help uninstall`
```
Remove hooks and configuration

Usage:
  lcm uninstall [--dry-run]

Options:
  --dry-run    Preview changes without writing anything
```

#### `lcm help status`
```
Show daemon and project memory status

Usage:
  lcm status [--json]

Options:
  --json    Output raw JSON (useful for scripting)

Examples:
  lcm status        Human-readable status
  lcm status --json Machine-readable output
```

#### `lcm help compact`
```
Compact conversation history into summaries

Usage:
  lcm compact [options]

Options:
  --all        Compact all projects (default: current directory only)
  --dry-run    Preview what would be compacted without writing
  --replay     Recompact sessions in sequence, each building on the
               previous session's context

Examples:
  lcm compact              Compact current project
  lcm compact --all        Compact all known projects
  lcm compact --dry-run    Preview without writing
```

#### `lcm help import`
```
Import Claude Code session transcripts into memory

Usage:
  lcm import [options]

Options:
  --all        Import sessions from all projects (default: current directory)
  --verbose    Show per-session import details
  --dry-run    Preview without writing
  --replay     Recompact imported sessions in sequence, building
               cross-session context threading

Examples:
  lcm import               Import sessions for current project
  lcm import --all         Import all projects
  lcm import --dry-run     Preview without writing
  lcm import --replay      Re-run with cross-session threading
```

#### `lcm help promote`
```
Promote insights from summaries to long-term memory

Usage:
  lcm promote [options]

Options:
  --all        Promote across all projects (default: current directory)
  --verbose    Show per-project promotion details
  --dry-run    Preview without writing

Examples:
  lcm promote              Promote for current project
  lcm promote --all        Promote across all projects
  lcm promote --dry-run    Preview without writing
```

#### `lcm help stats`
```
Show memory inventory and compression ratios

Usage:
  lcm stats [--verbose]

Options:
  --verbose, -v    Show per-project breakdown
```

#### `lcm help doctor`
```
Run health checks on all components

Usage:
  lcm doctor

Exits with code 1 if any check fails. Suitable for CI.
```

#### `lcm help diagnose`
```
Scan session transcripts for hook failures and errors

Usage:
  lcm diagnose [options]

Options:
  --all          Scan all projects (default: current directory)
  --days N       Number of days of history to scan (default: 7)
  --verbose      Show full details for each issue found
  --json         Output raw JSON

Examples:
  lcm diagnose             Scan last 7 days, current project
  lcm diagnose --all       Scan all projects
  lcm diagnose --days 30   Scan last 30 days
```

#### `lcm help sensitive`
```
Manage sensitive data redaction patterns

Usage:
  lcm sensitive <list|add|remove|test|purge> [options]

Subcommands:
  list     Show all active redaction patterns
  add      Add a new pattern
  remove   Remove a pattern
  test     Test a string against active patterns
  purge    Remove all patterns
```

#### `lcm help connectors`
```
Manage AI agent connectors

Usage:
  lcm connectors <list|install|remove|doctor> [options]

Subcommands:
  list      List available agents and installed connectors
  install   Install a connector for an agent
  remove    Remove a connector
  doctor    Check connector health

Options (install/remove):
  --type rules|mcp|skill    Connector type (default: agent's default type)

Examples:
  lcm connectors list
  lcm connectors install "claude code"
  lcm connectors install "claude code" --type mcp
  lcm connectors remove "claude code"
  lcm connectors doctor
  lcm connectors doctor "claude code"
```

---

## Progress / UI Helpers

### `src/cli/ui.ts` API

```
step(msg)   dim "  → msg"  stderr   — before blocking operations
done(msg)   green "  ✓ msg" stdout  — on success
fail(msg)   red "  ✗ msg"  stderr   — on error (replaces console.error)
warn(msg)   yellow "  ! msg" stderr — non-fatal warnings
info(msg)   plain "  msg"   stdout  — supporting detail lines
```

Color is applied only when `process.stdout.isTTY` is true and `NO_COLOR` is not set.

### Commands enhanced

**`promote`** (currently: silent for ~5s, then one line)
```
→ Connecting to daemon...
→ Scanning summaries...
✓ 3 insights promoted to long-term memory
```

**`import`** (currently: silent for ~5s, then prints)
```
→ Connecting to daemon...
  Importing sessions (current project)...
  12 sessions imported (847 messages)
```

**`compact`** (currently: silent for ~5s, then prints)
```
→ Connecting to daemon...
  [existing batchCompact output unchanged]
```

**Error paths** (currently: bare `console.error`)
- `fail("Daemon not available. Start with: lcm daemon start --detach")`
- `fail("Unknown agent: foo")`
- etc.

### Rule

Only add `step()` before silent blocking operations (daemon connect, network fetch). Do not add noise to commands that already print promptly.

---

## Data Structure (`src/cli/help.ts`)

```typescript
interface Flag {
  flag: string;
  description: string;
}

interface Example {
  cmd: string;
  note?: string;
}

interface CommandDef {
  name: string;
  description: string;
  usage?: string[];
  flags?: Flag[];
  examples?: Example[];
  subcommands?: CommandDef[];
  hidden?: boolean; // true for hook commands
}

interface CommandGroup {
  title: string;
  commands: CommandDef[];
}
```

---

## Not In Scope

- Commander.js migration (issue #36)
- Interactive prompts or wizards
- Man page generation
- Shell completion scripts
