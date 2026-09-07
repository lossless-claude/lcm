# Claude Code Hook Protocol

This document describes the stdin payload fields that Claude Code delivers to each lcm hook command.

All hooks receive a JSON object via stdin. lcm hooks are invoked as shell commands:

```
lcm <hook-command> < <stdin-json>
```

## Plugin installations

When installed as a Claude Code plugin, hooks run through the plugin's `lcm.mjs` launcher. The launcher starts the same CLI commands described below and forwards their arguments and stdin payloads.

The launcher now correctly starts the CLI. Previously, plugin hooks could exit silently without restoring context or recording session activity. Update the installed plugin to receive this fix; no hook configuration changes are required.

## PreCompact Hook

**Command:** `lcm compact --hook`

Invoked by Claude Code before it runs its built-in compaction. lcm writes a DAG summary of the session and prints it on stdout. The hook always exits `0`; it never blocks or replaces the built-in compaction. Empty stdout means lcm deferred (daemon unavailable or nothing to compact).

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory of the Claude Code session |
| `hook_event_name` | string | `"PreCompact"` |

**Response:** Exit code `0`. Summary text on stdout when the daemon compacted; empty stdout to defer.

## SessionStart Hook

**Command:** `lcm restore`

Invoked at the start of a Claude Code session. lcm restores recent summaries and promoted memory, injects them as a user message prefix, and prints a `<context>` block on stdout.

On startup, resume, and clear, lcm saves a snapshot of the applicable `CLAUDE.md` files without adding another copy to the restored context. Claude Code supplies those instructions itself. After compaction, lcm replays the saved snapshot so the instructions remain available.

The snapshot reads `~/.claude/CLAUDE.md`, `CLAUDE.md` in the working directory, and `.claude/CLAUDE.md` in the working directory. If multiple paths resolve to the same file, lcm includes it only once, including when you start Claude Code in your home directory. This behavior is automatic and needs no configuration.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionStart"` |
| `source` | string (optional) | `"startup"`, `"resume"`, `"clear"`, or `"compact"`; compaction replays the saved instructions |

If `source` is missing or unrecognized, lcm uses a recent compaction marker for the same session to decide whether to replay the saved instructions. Explicit `"startup"`, `"resume"`, and `"clear"` values override that fallback; `"compact"` always requests replay.

**Response:** Exit code `0`. Context is injected via stdout (printed as a `<context>` block that Claude Code prepends to the session).

## SessionEnd Hook

**Command:** `lcm session-end`

Invoked when the Claude Code session ends. lcm ingests the completed session transcript and triggers passive-learning event promotion.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionEnd"` |

**Response:** Exit code `0`. Runs best-effort; failures do not block session exit.

## UserPromptSubmit Hook

**Command:** `lcm user-prompt`

Invoked on each user prompt. lcm searches memory for relevant hints and injects a `<memory-hints>` block into the prompt.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `prompt` | string | The user's prompt text |
| `hook_event_name` | string | `"UserPromptSubmit"` |

**Response:** Exit code `0`. Hints are injected via stdout when relevant matches are found.

## PostToolUse Hook

**Command:** `lcm post-tool`

Invoked after every tool call. lcm extracts structured events (decisions, errors, git ops, etc.) and writes them to the passive-learning sidecar database.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `tool_name` | string | Name of the tool that was called |
| `tool_input` | object | The tool's input arguments |
| `tool_response` | any | The tool's response object |
| `tool_output` | string | Plaintext output (if available) |
| `hook_event_name` | string | `"PostToolUse"` |

**Response:** Always exit code `0`. This hook runs on every tool call and must be fast; it does no network I/O and only writes to a local sidecar SQLite database.

## SessionSnapshot Hook

**Command:** `lcm session-snapshot`

An optional periodic hook that incrementally ingests the live session transcript between `SessionEnd` events. This is used for long-running sessions where you want memory to be updated without waiting for the session to end.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `transcript_path` | string | Path to the live JSONL session transcript |
| `hook_event_name` | string | `"SessionSnapshot"` (if provided) |

**Response:** Exit code `0`.

## Auto-heal

All lcm hooks self-repair on each invocation: before dispatching, `validateAndFixHooks()` checks that all required hook entries remain registered in `~/.claude/settings.json` and re-adds any missing entries. This means lcm hooks survive `claude settings reset` or manual edits to the settings file.
