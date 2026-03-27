# Architecture

This document explains how lossless-claude works — the two-layer memory model, DAG compaction, context assembly, and expansion system.

## Two-layer memory model

lossless-claude maintains two complementary memory layers:

### Episodic layer (session history)

Every message from every Claude Code session is stored in a per-project SQLite database. Messages are organized into conversations (one per session) and carry:

- **seq** — Sequence number within the conversation
- **role** — `user`, `assistant`, `system`, or `tool`
- **content** — Plain text extraction
- **tokenCount** — Estimated tokens (~4 chars/token)
- **message_parts** — Structured content blocks preserving original shape (text, tool calls, results, reasoning, file content)

When conversations grow too large, older messages are **compacted into a DAG of summaries**. The original messages are preserved — summaries point back to their sources.

### Semantic layer (promoted memory)

Durable insights — architectural decisions, bug root causes, user preferences, integration patterns — are **promoted** from episodic summaries into a cross-session knowledge store.

Promoted entries are:
- Tagged with categories (e.g., `decision`, `architecture`, `preference`)
- Searchable via `lcm_search` across all sessions
- Automatically surfaced on session start and each user prompt
- Deduplicated via BM25 similarity matching

## The summary DAG

Summaries form a directed acyclic graph with increasing levels of abstraction:

```
Messages (raw)
    |
    v
Leaf summaries (depth 0)     <- 800-1200 tokens, from message chunks
    |
    v
Condensed d1 summaries       <- 1500-2000 tokens, from leaf groups
    |
    v
Condensed d2+ summaries      <- progressively more abstract
```

**Leaf summaries** (depth 0, kind `"leaf"`):
- Created from a chunk of raw messages
- Linked to source messages via `summary_messages`
- Narrative form with timestamps

**Condensed summaries** (depth 1+, kind `"condensed"`):
- Created from same-depth summaries
- Linked to parent summaries via `summary_parents`
- Each depth tier uses a progressively more abstract prompt

Every summary carries a `summaryId` (`sum_` + 16 hex chars), depth, time range, descendant count, and token estimate.

## Compaction lifecycle

### Ingestion

1. **Bootstrap** — On session start, reconciles the JSONL session file with the LCM database (crash recovery)
2. **Ingest** — Persists new messages and appends them to the context item list
3. **After turn** — Evaluates whether compaction should run

### Leaf compaction

1. Find the oldest chunk of raw messages outside the **fresh tail** (protected recent messages)
2. Cap at `leafChunkTokens` (default 20k tokens)
3. Send to LLM with the leaf prompt, passing the most recent prior summary for continuity
4. Persist the summary, link to source messages, replace the message range in the context item list

### Condensation

1. Find the shallowest depth with enough same-depth summaries (>= fanout threshold)
2. Concatenate their content with time range headers
3. Send to LLM with the depth-appropriate prompt
4. Persist at depth + 1, link to parent summaries

### Three-level escalation

Every summarization attempt follows this escalation to guarantee progress:

1. **Normal** — Standard prompt, temperature 0.2
2. **Aggressive** — Tighter prompt requesting only durable facts, temperature 0.1
3. **Fallback** — Deterministic truncation to ~512 tokens

### Compaction modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| Incremental | After each turn | One leaf pass if raw tokens exceed threshold |
| Full sweep | `/lcm-compact` or overflow | Repeated leaf + condensation passes until no progress |
| Budget-targeted | Overflow recovery | Up to 10 rounds until context is under target |

## Context assembly

The assembler runs before each model turn and builds the message array:

```
[summary_1, summary_2, ..., summary_n, message_1, message_2, ..., message_m]
 |---- budget-constrained ----|  |---- fresh tail (always included) ----|
```

Steps:
1. Fetch all context items ordered by position
2. Resolve each item — summaries become user messages with XML wrappers; messages are reconstructed from parts
3. Split into evictable prefix and protected fresh tail
4. Fill remaining budget from evictable set, keeping newest, dropping oldest
5. Sanitize tool-use/result pairing (every `tool_result` must have a matching `tool_use`)

### Summary XML format

Summaries are presented to the model wrapped in XML:

```xml
<summary id="sum_abc123" kind="leaf" depth="0" descendant_count="0"
         earliest_at="2026-02-17T07:37:00" latest_at="2026-02-17T08:23:00">
  <content>
    ...summary text...
    Expand for details about: exact error messages, config values
  </content>
</summary>
```

The XML attributes give the model metadata to reason about summary age, scope, and how to drill deeper.

## Expansion system

When summaries are too compressed, agents use `lcm_expand` (or the higher-level `lcm_expand_query`) to recover detail by walking the DAG back to source material.

The expansion sub-agent:
1. Receives a delegation grant scoped to specific conversations with a token cap
2. Walks parent links down to source messages
3. Returns a focused answer with cited summary IDs
4. Grant is revoked on completion

## Large file handling

Files exceeding `largeFileTokenThreshold` (default 25k tokens) are:
1. Stored to `~/.claude/lcm-files/<conversation_id>/<file_id>.<ext>`
2. Replaced in the message with a compact reference and ~200 token exploration summary
3. Retrievable via `lcm_describe` by file ID

## Passive learning

Two hooks capture events during sessions:

- **PostToolUse** — Extracts tool metadata (never raw output)
- **UserPromptSubmit** — Detects decisions, role statements, intent patterns

Events are stored in a per-project sidecar SQLite database and promoted to cross-session memory at session boundaries through a three-tier system (immediate, batch, pattern reinforcement).

## Session reconciliation

On session start, LCM reads the JSONL session file and compares against its database. Any messages present in the file but not in LCM are imported — handling crashes where Claude Code wrote messages but LCM didn't persist them.

## Data storage

| Location | Contents |
|----------|----------|
| `~/.lossless-claude/config.json` | Global configuration |
| `~/.lossless-claude/projects/{hash}/db.sqlite` | Per-project conversation database |
| `~/.lossless-claude/events/{hash}.db` | Per-project passive learning events |
| `~/.lossless-claude/daemon.pid` | Daemon process ID |
| `~/.claude/lcm-files/` | Stored large files |

All data stays on your machine. The only external communication is to the configured summarizer provider. See [Configuration > Sensitive Patterns](configuration.md#sensitive-patterns) for secret redaction.
