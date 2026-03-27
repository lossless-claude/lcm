# lossless-claude Documentation

> DAG-based memory for Claude Code — every message preserved, nothing lost.

## Quick links

| Doc | What it covers |
|-----|---------------|
| [Getting Started](getting-started.md) | Install, first session, verify with `/lcm-doctor` |
| [Configuration](configuration.md) | `config.json`, environment variables, sensitive patterns |
| [MCP Tools](mcp.md) | 7 tools for searching, storing, and inspecting memory |
| [Commands](commands.md) | 10 slash commands (`/lcm-compact`, `/lcm-curate`, etc.) |
| [CLI](cli.md) | 22 `lcm` subcommands for terminal use |
| [Hooks](hooks.md) | 6 lifecycle hooks (SessionStart through SessionEnd) |
| [Architecture](architecture.md) | Two-layer memory model, DAG compaction, context assembly |
| [Skills](agents.md) | 4 skills (lcm-context, lcm-dogfood, lcm-e2e, upgrade) |
| [Troubleshooting](troubleshooting.md) | Error messages, `lcm doctor` output, common fixes |

## How it works (30-second version)

1. **Every message is stored** in a per-project SQLite database
2. When context fills, older messages are **compacted into a DAG of summaries** (nothing is dropped)
3. Durable insights are **promoted** to cross-session memory
4. New sessions **restore** context from summaries and promoted memory automatically
5. You can **search, expand, and store** memories using MCP tools or slash commands

## Privacy

All data stays on your machine. The only exception is the summarizer — if you configure an external LLM provider (Anthropic API, OpenAI, etc.), message batches are sent for summarization after built-in secret redaction. See [Configuration > Sensitive Patterns](configuration.md#sensitive-patterns).
