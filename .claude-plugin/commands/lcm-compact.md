---
name: lcm-compact
description: Compact conversation messages into DAG summary nodes.
user_invocable: true
---

# /lcm-compact

Compact unprocessed conversation messages into summarized DAG nodes.

## Instructions

Run the following command via Bash:

```bash
lcm compact --all
```

### Options

If the user specifies options, append them to the command:
- `--verbose` — Show per-conversation details
- `--dry-run` — Preview without writing

For example:
- `/lcm-compact --verbose` → `lcm compact --all --verbose`
- `/lcm-compact --dry-run` → `lcm compact --all --dry-run`

Display the output verbatim.

**Note:** `lcm compact` without `--all` falls through to hook dispatch (PreCompact). This command always uses the batch path with `--all`.
