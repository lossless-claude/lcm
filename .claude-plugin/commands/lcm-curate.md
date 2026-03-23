---
name: lcm-curate
description: "Run the full memory curation pipeline: import, compact, and promote."
user_invocable: true
---

# /lcm-curate

Run the full memory curation pipeline: import, compact, and promote.

## Instructions

Run the following commands sequentially via Bash:

```bash
lcm import && lcm compact && lcm promote
```

### Options

Pass user-specified flags through to the commands that support them:
- `--all` — Process all projects (default: current project only); applies to all three commands
- `--verbose` — Show per-step details; applies to `import` and `promote` only (compact does not support `--verbose`)
- `--dry-run` — Preview without writing; applies to all three commands

For example:
- `/lcm-curate --all` → `lcm import --all && lcm compact --all && lcm promote --all`
- `/lcm-curate --all --verbose` → `lcm import --all --verbose && lcm compact --all && lcm promote --all --verbose`
- `/lcm-curate --dry-run` → `lcm import --dry-run && lcm compact --dry-run && lcm promote --dry-run`

The pipeline stops on the first failure and reports the result.

Display the output verbatim.
