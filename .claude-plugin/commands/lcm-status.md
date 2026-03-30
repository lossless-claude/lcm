---
name: lcm-status
description: Show daemon state and project memory statistics.
user_invocable: true
---

# /lcm-status

Show daemon state and project memory statistics.

## Instructions

Run the following command via Bash:

```bash
lcm status
```

If `lcm` is not on PATH (marketplace install), use the plugin-relative binary instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs" status
```

### Options

If the user specifies options, append them to the command:
- `--json` — Return output in JSON format

For example:
- `/lcm-status --json` → `lcm status --json`

Display the output verbatim.
