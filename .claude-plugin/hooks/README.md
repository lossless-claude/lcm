# lossless-claude — Hooks

**Usage**: Lossless context management — every conversation is captured, compressed, and restored across sessions.

## Hooks

All hooks auto-heal: each validates that all 4 hooks are registered in `settings.json` before executing. If any are missing, they're silently repaired.

| Hook | Command | What it does |
|------|---------|-------------|
| PreCompact | `lcm compact --hook` | Intercepts compaction, runs LLM summarization into a DAG, returns the summary (exit 2 = replace native) |
| SessionStart | `lcm restore` | Restores project context + recent summaries + promoted memories from prior sessions |
| SessionEnd | `lcm session-end` | Ingests the session transcript into the database for future recall |
| UserPromptSubmit | `lcm user-prompt` | Searches promoted memory for relevant context, surfaces it as `<memory-context>` hints |

## Lifecycle

```
SessionStart ──→ conversation ──→ UserPromptSubmit (each turn)
                                         │
                               PreCompact (if context fills)
                                         │
                              SessionEnd (conversation exits)
```

1. **SessionStart**: daemon wakes, orientation + episodic + promoted context injected
2. **UserPromptSubmit**: each user message triggers a background memory search — relevant context appears as hints
3. **PreCompact**: when Claude's context window fills, lossless-claude intercepts and produces a DAG-based summary (nothing lost)
4. **SessionEnd**: full transcript ingested into SQLite for future sessions

## MCP Tools

Available alongside hooks for direct memory access:

```
lcm_search    # Search across episodic + promoted memory
lcm_grep      # Regex/full-text search across messages + summaries
lcm_expand    # Drill into a summary node for full detail
lcm_describe  # Summary metadata (depth, tokens, parent/child)
lcm_store     # Write to promoted knowledge store
lcm_stats     # Compression ratios and usage statistics
lcm_doctor    # Diagnostics — daemon, hooks, MCP, summarizer
```

## Why

Without lossless-claude, conversation history is lost when Claude compacts or when a session ends. With it, every message is preserved in a SQLite DAG, summaries are hierarchical (leaf → condensed → session → durable), and relevant context from past sessions surfaces automatically on each prompt.
