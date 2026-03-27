# Hooks

lossless-claude uses 6 Claude Code lifecycle hooks to capture, compress, and restore conversation memory automatically.

## Hook overview

| Hook | Command | When it fires | What it does |
|------|---------|---------------|-------------|
| SessionStart | `lcm restore` | Session begins | Restores project context, recent summaries, and promoted memories from prior sessions |
| UserPromptSubmit | `lcm user-prompt` | Each user message | Searches promoted memory for relevant context, injects it as `<memory-context>` hints |
| PostToolUse | `lcm post-tool` | After each tool call | Captures structured tool metadata for passive learning |
| PreCompact | `lcm compact --hook` | Context window fills | Intercepts native compaction, produces DAG summary instead (exit 2 = replace native) |
| SessionEnd | `lcm session-end` | Session exits | Ingests the full transcript into SQLite for future recall |
| Stop | `lcm session-end` | Model stops generating | Same as SessionEnd — ensures transcript is captured even on early termination |

## Lifecycle flow

```
SessionStart ──→ conversation loop ──→ UserPromptSubmit (each turn)
                                              │
                                    PostToolUse (each tool call)
                                              │
                                    PreCompact (if context fills)
                                              │
                              SessionEnd / Stop (conversation exits)
```

## Hook details

### SessionStart (`lcm restore`)

Fires when a Claude Code session begins. The daemon wakes up and assembles a context injection from three sources:

1. **Orientation** — Project-level metadata and configuration
2. **Episodic memory** — Recent conversation summaries from the DAG
3. **Promoted memory** — Durable cross-session insights (architectural decisions, user preferences, bug root causes)

The assembled context is returned as the hook's stdout and injected into the model's initial context.

### UserPromptSubmit (`lcm user-prompt`)

Fires on each user message. Searches the promoted memory store for entries relevant to the current prompt and working directory, then surfaces matching context as `<memory-context>` hints before the model responds.

Also records the user's prompt for passive learning — detecting decisions, role statements, and intent patterns.

### PostToolUse (`lcm post-tool`)

Fires after every tool call. Extracts structured metadata (tool name, command, file path) from tool inputs for passive learning. Never captures raw tool output — only metadata.

Captured events feed the three-tier promotion system:
- **Tier 1 (immediate):** Decisions, plan approvals, error-fix pairs
- **Tier 2 (batch):** Git operations, environment changes
- **Tier 3 (pattern):** File access patterns, tool usage frequency

### PreCompact (`lcm compact --hook`)

Fires when Claude Code's context window fills and it wants to compact. lossless-claude intercepts this and produces a DAG-based summary instead of Claude's native compaction.

Returns exit code 2 with the summary text, which tells Claude Code to use this summary instead of its own. If the daemon is unreachable, returns exit code 0 to let native compaction proceed as fallback.

### SessionEnd / Stop (`lcm session-end`)

Fires when the session ends normally or when the model stops generating. Ingests the full session transcript into the SQLite database for future recall by `lcm_search` and `lcm_grep`.

## Auto-heal

All hooks auto-heal on every invocation. Before executing, each hook validates that all 6 hooks are properly registered in `~/.claude/settings.json`. If any are missing or stale, they're silently repaired.

This means a single successful hook fire fixes the entire hook chain — even if `settings.json` was manually edited or corrupted.

## Registration

Hooks are registered in two places:

1. **`~/.claude/settings.json`** — Hardcoded hooks that run regardless of plugin state. These are the primary registration and are maintained by auto-heal.
2. **`.claude-plugin/hooks/`** — Plugin-system hooks (currently informational only — the plugin.json no longer declares hooks directly).

## Hook input

All hooks receive a JSON object on stdin with at least:
- `session_id` — Session identifier
- `cwd` — Working directory
- `hook_event_name` — The lifecycle event name

Additional fields vary by hook (e.g., UserPromptSubmit includes `prompt`).

## Troubleshooting

If hooks aren't firing:

1. Run `/lcm-doctor` to check hook registration
2. Run `/lcm-diagnose` to scan recent sessions for hook failures
3. If hooks are missing, run `lcm install` to re-register them
4. Check that the node binary path in settings.json is valid

See [Troubleshooting](troubleshooting.md) for more details.
