---
name: lcm-status
description: Show daemon state and project memory statistics.
user_invocable: true
---

# /lcm-status

Show daemon state and project memory statistics.

## Binary Resolution

If `lcm` is not on PATH, use the plugin's bundled binary instead:

```bash
node ~/.claude/plugins/cache/*/lossless-claude/*/lcm.mjs
```

Replace `lcm` with the command above in all instructions below.

## Instructions

Run the following command via Bash:

```bash
lcm status
```

### Options

If the user specifies options, append them to the command:
- `--json` — Return output in JSON format

For example:
- `/lcm-status --json` → `lcm status --json`

Display the output verbatim.
