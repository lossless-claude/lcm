---
name: lcm-stats
description: Show lossless-claude memory inventory, compression ratios, and DAG statistics.
user_invocable: true
---

# /lcm-stats

Show memory and compression statistics from lossless-claude.

## Instructions

When invoked, call the `lcm_stats` MCP tool with `{"verbose": true}`.

The tool returns pre-formatted markdown with Memory and Compression tables. Display the output verbatim — it is already formatted correctly.

If `lcm_stats` is unavailable, run `lcm stats -v` via Bash and display the output verbatim. If `lcm` is not on PATH (marketplace install), use `node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs" stats -v` instead.

Do not add commentary — just the stats output.
