# Agent tools

LCM provides seven MCP tools for agents to search, inspect, store, and recall information from conversation history.

## Usage patterns

### Escalation pattern: grep → describe → expand

Most recall tasks follow this escalation:

1. **`lcm_grep`** — Find relevant summaries or messages by keyword/regex
2. **`lcm_describe`** — Inspect a specific summary's metadata and lineage (cheap, no DAG traversal)
3. **`lcm_expand`** — Deep recall: decompress a summary node into its full source content

Start with grep. If the snippet is enough, stop. If you need metadata, use describe. If you need details that were compressed away, use expand.

### When to search vs. grep

- **`lcm_search`** — Use when looking for knowledge across sessions in natural language. Returns ranked results from both episodic (SQLite) and semantic memory layers.
- **`lcm_grep`** — Use when you know an exact keyword, error message, or function name from a specific session.

### When to expand

Summaries are lossy by design. The "Expand for details about:" footer at the end of each summary lists what was dropped. Use `lcm_expand` when you need:

- Exact commands, error messages, or config values
- File paths and specific code changes
- Decision rationale beyond what the summary captured
- Tool call sequences and their outputs
- Verbatim quotes or specific data points

## Tool reference

### lcm_search

Hybrid search across episodic memory (SQLite FTS5) and semantic memory. Returns two separate ranked lists. Use when looking for project knowledge spanning multiple sessions.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Natural language search query |
| `limit` | number | | `5` | Max results per layer |
| `layers` | string[] | | both | `"episodic"`, `"semantic"`, or both |
| `tags` | string[] | | — | Filter to entries that include all specified tags |

**Examples:**

```
# Find past decisions about authentication
lcm_search(query: "authentication decision")

# Search only semantic layer, filtered by tag
lcm_search(query: "database migration", layers: ["semantic"], tags: ["type:decision"])
```

### lcm_grep

Search conversation history by keyword or regex across raw messages and summaries.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Keyword, phrase, or regex to search |
| `scope` | string | | `"all"` | `"messages"`, `"summaries"`, or `"all"` |
| `sessionId` | string | | — | Filter to a specific session |
| `since` | string | | — | ISO datetime lower bound |

**Returns:** Array of matches with content snippet, type (message or summary), and session ID.

**Examples:**

```
# Search for an error message across all history
lcm_grep(query: "ECONNREFUSED")

# Search only summaries for a specific term
lcm_grep(query: "config\\.threshold", scope: "summaries")
```

### lcm_describe

Inspect metadata and lineage of a memory node without expanding content. Returns depth, token count, parent/child links, and whether the node was promoted to long-term memory.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeId` | string | ✅ | — | Node ID to describe (e.g. `sum_abc123`) |

**Examples:**

```
# Inspect a summary from context
lcm_describe(nodeId: "sum_abc123def456")
```

### lcm_expand

Decompress a summary node into its full source content by traversing the DAG. Use when a summary references details you need but doesn't include them verbatim.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeId` | string | ✅ | — | Summary node ID to expand |
| `depth` | number | | `1` | How many levels of the DAG to traverse |

**Examples:**

```
# Expand a leaf summary one level deep
lcm_expand(nodeId: "sum_abc123")

# Expand a condensed summary, traversing two levels
lcm_expand(nodeId: "sum_def456", depth: 2)
```

### lcm_store

Store a memory into lossless-claude's semantic layer. Use to persist decisions, findings, reasoning outcomes, or any knowledge worth retrieving in future sessions.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | ✅ | — | The content to store |
| `tags` | string[] | | — | Canonical tags (see [tag-schema.md](tag-schema.md)) |
| `metadata` | object | | — | Optional key/value metadata |

**Examples:**

```
# Store an architectural decision
lcm_store(
  text: "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies.",
  tags: ["type:decision", "scope:security", "project:lcm"]
)

# Store a solution with sprint tag
lcm_store(
  text: "Fixed ECONNREFUSED by calling ensureDaemon before the request.",
  tags: ["type:solution", "scope:lcm", "sprint:sp4"]
)
```

### lcm_stats

Show token savings, compression ratios, and usage statistics across all lossless-claude projects.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `verbose` | boolean | | `false` | Include per-conversation breakdown |

### lcm_doctor

Run diagnostics on the lossless-claude installation. Checks daemon, hooks, MCP config, and summarizer health.

**Parameters:** none.

## Tips for agent developers

### Configuring agent prompts

Add instructions to your agent's system prompt so it knows when to use LCM tools:

```markdown
## Memory & Context

Use LCM tools for recall:
1. `lcm_search` — Hybrid search across all memory layers (broad recall)
2. `lcm_grep` — Search by keyword/regex (exact match)
3. `lcm_describe` — Inspect a specific summary's metadata (cheap, no expansion)
4. `lcm_expand` — Expand a summary node into source content (when you need lost detail)
5. `lcm_store` — Persist a decision or finding for future sessions

When summaries in context have an "Expand for details about:" footer
listing something you need, use `lcm_expand` with that summary's node ID.
```

### Performance considerations

- `lcm_search`, `lcm_grep`, and `lcm_describe` are fast (direct database queries)
- `lcm_expand` traverses the DAG and reads source messages — cost scales with depth
- `lcm_stats` performs full-table scans — use sparingly, not in request handlers
- Token caps (`LCM_MAX_EXPAND_TOKENS`) prevent runaway expansion
