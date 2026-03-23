# lcm diagnose — Design Spec

**Date:** 2026-03-21
**Status:** Draft

## Context

Claude Code stores session transcripts as JSONL files with rich metadata including hook progress events, MCP server lifecycle, and error indicators. `lcm doctor` checks current health (daemon, hooks, settings), but there's no way to look at **historical** errors — which hooks failed, when MCP disconnected, or whether old binary names are still being invoked.

`lcm diagnose` scans Claude Code's session transcripts for lcm-related errors and surfaces a summary. It complements `doctor` (current state) and `import` (session recovery).

## CLI Interface

```
lcm diagnose [--all] [--days N] [--verbose] [--json]
```

| Flag | Default | Behavior |
|------|---------|----------|
| (no flag) | — | Scan current project's sessions |
| `--all` | off | Scan all projects |
| `--days N` | 7 | Only scan sessions modified in last N days |
| `--verbose` | off | Show each error with full context |
| `--json` | off | Machine-readable output |

## Error Patterns

The scanner reads JSONL files line-by-line (no full parse) and looks for these patterns:

### 1. Hook errors

JSONL entries with `"type":"progress"` and `"data":{"type":"hook_progress"}` where the command contains `lcm` or `lossless-claude`. The scanner looks for:
- Entries followed by error indicators (stderr output, non-zero exit)
- Hook start entries without corresponding completion in the same prompt cycle

Detection: grep for `hook_progress` entries containing `lcm` or `lossless-claude`, then check for `error`, `fail`, `stderr`, `exit` in nearby lines.

### 2. MCP server disconnects

Entries containing `"type":"system"` with messages about MCP server disconnection mentioning `lossless-claude` or `lcm`.

Detection: grep for lines matching `disconnect.*lcm\|disconnect.*lossless-claude\|lcm.*disconnect`.

### 3. Old binary references

Hook progress entries that invoke `lossless-claude` instead of `lcm`. These indicate the migration hasn't completed or hooks are stale.

Detection: grep for `hook_progress` entries where `command` contains `lossless-claude` (not in data dir path context).

### 4. Duplicate hook firing

Multiple `hook_progress` entries for the same `hookEvent` + `command` within a single prompt cycle (same `parentToolUseID`). Indicates the settings.json + plugin.json duplication bug.

Detection: group `hook_progress` entries by `parentToolUseID` + `hookEvent` + `command`, flag groups with count > 1.

## Data Flow

```
~/.claude/projects/<hash>/*.jsonl
  → filter by mtime (--days N)
  → scan line-by-line for patterns
  → aggregate: { sessionId, sessionName?, errors: [{ type, count, details }] }
  → report summary
```

Reuses `cwdToProjectHash` from `src/import.ts` for project directory resolution. Uses the same `findSessionFiles` pattern but filters by file mtime.

## Implementation

### New file: `src/diagnose.ts`

Core types:
```typescript
interface DiagnosticError {
  type: 'hook-error' | 'mcp-disconnect' | 'old-binary' | 'duplicate-hook';
  hookEvent?: string;
  command?: string;
  timestamp?: string;
  details?: string;
  count: number;
}

interface SessionDiagnostic {
  sessionId: string;
  sessionName?: string;
  filePath: string;
  errors: DiagnosticError[];
}

interface DiagnoseResult {
  sessionsScanned: number;
  sessionsWithErrors: number;
  totalErrors: number;
  totalWarnings: number;
  sessions: SessionDiagnostic[];
  mostCommon?: { type: string; count: number };
}
```

Core function:
```typescript
export function scanSession(filePath: string): DiagnosticError[]
```

Reads the JSONL file line-by-line. For each line:
1. Try `JSON.parse` — skip malformed lines
2. Check if it's a `hook_progress` entry with lcm/lossless-claude command
3. Check for MCP disconnect mentions
4. Track `parentToolUseID` groups for duplicate detection
5. Check for old binary name

Returns aggregated errors for the session.

Main entry:
```typescript
export async function diagnose(options: DiagnoseOptions): Promise<DiagnoseResult>
```

Resolves project directories (same pattern as `import.ts`), filters by mtime, scans each session, aggregates results.

### CLI: `bin/lcm.ts`

New `diagnose` case — no daemon required (reads files directly, no `/ingest` calls). Formats output as table or JSON.

### Plugin skill: `.claude-plugin/commands/lcm-diagnose.md`

Teaches agents when to use diagnose:
- After seeing hook errors in a session
- When investigating why sessions weren't ingested
- As part of troubleshooting workflow: `lcm doctor` (current) → `lcm diagnose` (history) → `lcm import` (recovery)

## Output Format

### Text (default)
```
  Scanning 70 sessions (last 7 days)...

  Session fddfffc4 (cli refactor, 2026-03-21):
    ✗ UserPromptSubmit hook error (3x)
    ✗ SessionEnd hook timeout (1x)

  Session cf1c71a9 (2026-03-20):
    ✗ MCP server disconnect (2x)
    ⚠ Hook uses old binary: lossless-claude compact

  4 sessions with issues, 6 total errors, 1 warning

  Most common: UserPromptSubmit hook error (3x across 1 session)
  Suggestion: Run `lcm doctor` to check current health
```

### JSON (`--json`)
```json
{
  "sessionsScanned": 70,
  "sessionsWithErrors": 4,
  "totalErrors": 6,
  "totalWarnings": 1,
  "sessions": [
    {
      "sessionId": "fddfffc4",
      "errors": [
        { "type": "hook-error", "hookEvent": "UserPromptSubmit", "count": 3 }
      ]
    }
  ]
}
```

## Testing

- Mock JSONL files with known error patterns
- Verify each error type is detected
- Verify `--days` filters by mtime
- Verify `--json` output is valid JSON
- Verify session name extraction from `custom-title` entries
- Verify duplicate hook detection with same `parentToolUseID`

## Files Summary

| File | Action |
|------|--------|
| `src/diagnose.ts` | Create — scanner + aggregator |
| `bin/lcm.ts` | Edit — add `diagnose` case |
| `.claude-plugin/commands/lcm-diagnose.md` | Create — plugin skill |
| `test/diagnose.test.ts` | Create — tests |
| `src/connectors/templates/sections/command-reference.md` | Edit — add diagnose |
