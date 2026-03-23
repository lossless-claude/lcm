---
name: lcm-context
description: "You MUST use this before any work to recall project memory, and after implementing to store decisions. Lossless-claude (lcm) provides persistent cross-session memory via CLI commands."
---

# lcm Memory — Universal Agent Guide

Use the `lcm` CLI to retrieve and store project memory across sessions.
Install: `npm install -g @lossless-claude/lcm`

Memory is stored in SQLite (FTS5) and accessed via CLI commands or MCP tools.

## Workflow

1. **Before Thinking:** Run `lcm search` or `lcm grep` to recall past decisions and context.
2. **After Implementing:** Run `lcm store` to persist new decisions, patterns, or findings.

## Commands

### 1. Search Memory (broad recall)

Retrieve relevant context across all past sessions using full-text search.

**Use when:**
- You need to recall past decisions, patterns, or architectural context
- Before performing any action, to check for relevant rules or preferences
- Your context does not contain information you need

**Do NOT use when:**
- The information is already present in your current context
- The query is about general knowledge, not project memory

```bash
lcm search "how was auth implemented"
lcm search "compaction architecture" --tags decision,architecture
lcm search "JWT token" --layers episodic
```

### 2. Grep Memory (exact match)

Search raw conversation transcripts by keyword or regex.

**Use when:**
- You need an exact keyword, error message, or function name from past sessions
- Search returned too many broad results and you need to narrow down

**Do NOT use when:**
- You need conceptual recall (use `lcm search` instead)

```bash
lcm grep "socket.unref"
lcm grep "JWT" --scope summaries
lcm grep "ECONNREFUSED" --since 2026-03-20
```

### 3. Expand a Summary Node

Decompress a summary node from the DAG into its full source content.

**Use when:**
- A search or grep result references a summary nodeId and you need more detail
- Check with `lcm describe <nodeId>` first to see if it's worth expanding (saves tokens)

```bash
lcm describe <nodeId>    # check metadata first
lcm expand <nodeId>      # decompress if relevant
lcm expand <nodeId> --depth 2   # deeper traversal
```

### 4. Store a Decision or Finding

Persist knowledge for retrieval in future sessions.

**Use when:**
- An architectural decision was made with rationale worth preserving
- A bug root cause was identified (the "why", not just the fix)
- User expressed a preference or feedback that affects future work
- A non-obvious integration pattern was discovered

**Do NOT use when:**
- The information is already in git (code, commit messages)
- It's a transient debugging step or ephemeral task detail
- It's already documented in project instruction files (CLAUDE.md, AGENTS.md, etc.)
- It's general knowledge, not project-specific

```bash
lcm store "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies." --tags decision,auth
lcm store "SessionEnd hook only fires on graceful /exit, not on crash or terminal close" --tags finding,hooks
```

### 5. Check System Health

```bash
lcm doctor    # daemon, hooks, MCP, summarizer status
lcm stats     # compression ratios and token savings
```

## Retrieval Chaining Pattern

The retrieval tools compose from broad to deep:

```
lcm search "topic"       → broad conceptual matches
    ↓ (find interesting nodeId)
lcm grep "exact term"    → narrow to specific references
    ↓ (find nodeId worth expanding)
lcm describe <nodeId>    → check metadata (depth, tokens, promoted?)
    ↓ (if worth it)
lcm expand <nodeId>      → full decompressed content
```

## Error Handling

**Agent-Fixable (handle automatically):**

| Error | Recovery |
|---|---|
| Daemon not running | Run `lcm daemon start`, then retry |
| "No results" from search | Try `lcm grep` with different keywords, or broaden query |
| Node not found on expand | Use `lcm search` to find correct nodeId |

**User Action Required:**

| Error | What to tell the user |
|---|---|
| `lcm` command not found | Run `npm install -g @lossless-claude/lcm` |
| Daemon won't start | Ask user to check `lcm doctor` output |
| Database locked or corrupted | Ask user to run `lcm doctor` for diagnostics |

### Quick Diagnosis

```bash
lcm doctor    # check daemon, hooks, config health
lcm stats     # verify memory is being captured
```
