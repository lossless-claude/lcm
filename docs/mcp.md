# MCP Tools

lossless-claude exposes 7 MCP tools through its daemon. These tools are available to Claude automatically during any session where the plugin is installed.

## Tool overview

| Tool | Purpose | Typical use |
|------|---------|-------------|
| [`lcm_search`](#lcm_search) | Broad concept search across sessions | "How did we implement auth?" |
| [`lcm_grep`](#lcm_grep) | Exact keyword/regex match | "Find all mentions of JWT" |
| [`lcm_expand`](#lcm_expand) | Decompress a summary node | Drill into a search result for full detail |
| [`lcm_describe`](#lcm_describe) | Inspect node metadata | Check if a node is worth expanding |
| [`lcm_store`](#lcm_store) | Persist a finding for future sessions | Save an architectural decision |
| [`lcm_stats`](#lcm_stats) | View compression metrics | Check how much memory is stored |
| [`lcm_doctor`](#lcm_doctor) | Run diagnostics | Troubleshoot installation issues |

## Retrieval chain

The three retrieval tools chain from broad to deep:

```
lcm_search (broad concept recall)
    |
    v
lcm_grep (exact keyword match)
    |
    v
lcm_expand (decompress summary node)
```

**Start broad, go deeper as needed.** `lcm_search` finds relevant topics across sessions. `lcm_grep` narrows to exact references. `lcm_expand` recovers full detail from compressed summaries.

Use `lcm_describe` before expanding to check whether a node is worth the cost (token count, depth, freshness).

---

## lcm_search

Search across both episodic memory (session history) and promoted memory (curated insights) using FTS5 full-text search.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language search query |
| `limit` | number | no | 5 | Maximum results per layer |
| `layers` | string[] | no | both | Which layers to search: `"episodic"`, `"semantic"` |
| `tags` | string[] | no | — | Filter to entries matching all specified tags |

**Returns:** Two ranked lists — episodic results (from session history) and semantic results (from promoted memory). Each result includes a snippet, source reference, and relevance score.

**When to use:**
- Recalling past decisions: "How was the database schema designed?"
- Finding cross-session context: "What did we decide about error handling?"
- Looking up project knowledge that spans multiple sessions

**When NOT to use:**
- Information is already in your current context (injected by hooks at session start)
- Looking for general knowledge, not project-specific memory
- The answer is in the code or git history

---

## lcm_grep

Search conversation history by keyword or regex across raw messages and summaries.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Keyword, phrase, or regex pattern |
| `sessionId` | string | no | — | Filter to a specific session |
| `since` | string | no | — | ISO datetime lower bound |

**Returns:** Matching messages and summaries with surrounding context.

**When to use:**
- Finding exact error messages: "connection refused on port 5432"
- Locating specific code references: "useAuthContext"
- Searching for a particular tool or technology mentioned in conversations

---

## lcm_expand

Decompress a summary node into its full source content by traversing the DAG.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `nodeId` | string | yes | — | Summary node ID to expand (e.g., `sum_abc123`) |
| `depth` | number | no | 1 | How many levels of the DAG to traverse |

**Returns:** The decompressed source content — either the original messages (for leaf summaries) or the child summaries (for condensed nodes).

**When to use:**
- A search result references a summary and you need the full detail
- The summary's "Expand for details about:" footer lists information you need
- You need exact commands, error messages, config values, or code that was compressed away

---

## lcm_describe

Inspect metadata and lineage of a memory node without loading its content. This is a lightweight check before deciding to expand.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `nodeId` | string | yes | — | Node ID to inspect |

**Returns:** Metadata including:
- **depth** — Position in the DAG hierarchy (0 = leaf)
- **tokenCount** — How many tokens the node contains
- **parent/child links** — DAG relationships
- **promotion status** — Whether the node was promoted to long-term memory
- **time range** — Earliest and latest timestamps of source material

**When to use:**
- Before expanding a node, check if it's worth the token cost
- Understanding the DAG structure around a particular summary
- Checking whether a node is still relevant (time range)

---

## lcm_store

Persist a decision, finding, or insight into promoted memory for future sessions.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | yes | — | The content to store |
| `tags` | string[] | no | — | Categorical tags (e.g., `["decision", "architecture"]`) |
| `metadata` | object | no | — | Key/value metadata (e.g., `{projectId: "...", source: "..."}`) |

**Returns:** Confirmation with the stored node ID.

**When to use:**
- An architectural decision was made with rationale worth preserving
- A bug root cause was identified (the "why", not just the fix)
- A user expressed a preference or feedback that should persist across sessions
- A non-obvious integration pattern was discovered

**When NOT to use:**
- Information is already in git (code, commit messages)
- Transient debugging steps or ephemeral task details
- General knowledge, not project-specific

---

## lcm_stats

Show token savings, compression ratios, and usage statistics.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | boolean | no | false | Include per-conversation breakdown |

**Returns:** Pre-formatted markdown with memory inventory and compression tables.

---

## lcm_doctor

Run diagnostics on the installation — checks daemon status, hook registration, MCP configuration, and summarizer health.

**Parameters:** None.

**Returns:** Pre-formatted markdown with status tables per section. Each check shows a pass/fail icon.

**When to use:**
- After seeing hook errors in a session
- After upgrading lossless-claude
- When memory features seem to not be working

See [Troubleshooting](troubleshooting.md) for interpreting doctor output.

---

## Error recovery

### Agent-fixable errors

| Error | Recovery |
|-------|----------|
| Daemon not running | Run `lcm daemon start --detach`, then retry |
| "No results" from search | Try `lcm_grep` with different keywords, or broaden the query |
| Node not found on expand | Use `lcm_search` to find the correct nodeId |

### Errors requiring user action

| Error | What to do |
|-------|-----------|
| MCP server disconnected | Restart the Claude Code session, then run `/lcm-diagnose` |
| Hooks not firing | Run `/lcm-doctor` to confirm; if missing, run `lcm install` |
| Summarizer failing | Run `/lcm-doctor` for full diagnostics |
