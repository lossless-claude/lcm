---
name: lcm-diagnose
description: Scan recent Claude Code session transcripts for hook failures, MCP disconnects, and stale lcm hook setup.
user_invocable: true
---

# /lcm-diagnose

Inspect recent Claude Code transcripts for historical lcm issues.

## Instructions

Run `lcm diagnose` via Bash and display the output verbatim. If `lcm` is not on PATH (marketplace install), use `node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs" diagnose` instead.

If the user asks for a wider scan, use:
- `lcm diagnose --all`
- `lcm diagnose --all --days 30`
- `lcm diagnose --verbose`
- `lcm diagnose --json`

After showing the results, suggest the next troubleshooting step:
- `lcm doctor` for current install health
- `lcm import` if sessions were missed and need recovery

## When to use

- After seeing hook errors in a Claude Code session
- When investigating missing sessions or gaps in ingestion
- During troubleshooting: `lcm doctor` for current state, `lcm diagnose` for history, `lcm import` for recovery
