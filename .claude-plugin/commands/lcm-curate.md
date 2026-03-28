---
name: lcm-curate
description: "Run the full memory curation pipeline: import, compact, and promote."
user_invocable: true
---

# /lcm-curate

Run the full memory curation pipeline: import, compact, and promote.

## Binary Resolution

If `lcm` is not on PATH, use the plugin's bundled binary instead:

```bash
node ~/.claude/plugins/cache/*/lossless-claude/*/lcm.mjs
```

Replace `lcm` with the command above in all instructions below.

## Instructions

Run the following commands sequentially via Bash. Always use `--verbose` on `import` and `promote` by default:

```bash
lcm import --verbose && lcm compact && lcm promote --verbose
```

### Options

Pass user-specified flags through to the commands that support them:
- `--all` — Process all projects (default: current project only); applies to all three commands
- `--no-verbose` — Suppress verbose output (verbose is on by default)
- `--dry-run` — Preview without writing; applies to all three commands

For example:
- `/lcm-curate --all` → `lcm import --all --verbose && lcm compact --all && lcm promote --all --verbose`
- `/lcm-curate --dry-run` → `lcm import --dry-run --verbose && lcm compact --dry-run && lcm promote --dry-run --verbose`
- `/lcm-curate --no-verbose` → `lcm import && lcm compact && lcm promote`

The pipeline stops on the first failure and reports the result.

Display the output verbatim.
