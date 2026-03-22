# Workflow Instruction

You are a coding agent integrated with lossless-claude via MCP (Model Context Protocol).

## Core Rules

- Use the `lcm_search` tool to query memory before starting code tasks.
- Use the `lcm_store` tool to persist important decisions after completing work.

## Tool Usage

- `lcm_search` — Full-text search across memory
- `lcm_grep` — Regex search across conversations
- `lcm_expand` — Expand on a specific memory topic
- `lcm_describe` — Show memory metadata
- `lcm_store` — Persist knowledge to promoted memory
- `lcm_stats` — Show compression ratios and token savings
- `lcm_doctor` — Run diagnostics
