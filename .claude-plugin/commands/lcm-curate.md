---
name: lcm-curate
description: Run the full memory curation pipeline: import, compact, and promote.
user_invocable: true
---

# /lcm-curate

Run the full memory curation pipeline: import, compact, and promote.

## Instructions

Run the following commands sequentially via Bash:

```bash
lcm import --all && lcm compact --all && lcm promote
```

### Options

If the user specifies options, append them to all three commands:
- `--verbose` — Show per-step details
- `--dry-run` — Preview without writing

For example:
- `/lcm-curate --verbose` → `lcm import --all --verbose && lcm compact --all --verbose && lcm promote --verbose`
- `/lcm-curate --dry-run` → `lcm import --all --dry-run && lcm compact --all --dry-run && lcm promote --dry-run`

The pipeline stops on the first failure and reports the result.

Display the output verbatim.
