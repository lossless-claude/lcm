# Agent tools

LCM provides seven MCP tools for agents to search, inspect, store, and recall information from conversation history.

The MCP server speaks the [2026-07-28 protocol](https://modelcontextprotocol.io/specification/2026-07-28)
over stdio, powered by the TypeScript SDK v2, and also serves the earlier 2025-11-25
revision. Which one a connection uses is the client's choice; both reach the same seven
tools with the same arguments and text results. Only the newer revision carries the
result envelope (`resultType`, `ttlMs`, `cacheScope`, `_meta`). The entrypoints remain
`lcm mcp` (npm) and `node bundle/mcp-server.js` (the Claude Code plugin).

## Usage patterns

### Escalation pattern: grep → describe → expand

Most recall tasks follow this escalation:

1. **`lcm_grep`** — Find relevant summaries or messages by keyword/regex
2. **`lcm_describe`** — Inspect a specific summary's metadata and lineage (cheap, no DAG traversal)
3. **`lcm_expand`** — Deep recall: decompress a summary node into its full source content

Start with grep. If the snippet is enough, stop. If you need metadata, use describe. If you need details that were compressed away, use expand.

### When to search vs. grep

- **`lcm_search`** — Use when looking for knowledge across sessions. Returns ranked results from episodic history and promoted project memories.
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

Native search across episodic history and promoted memories. Returns two separate ranked lists. Use when looking for project knowledge spanning multiple sessions.

Native episodic matches contain up to 1,000 characters of exact source context, plus `span`,
`sourceHash`, and `snippetTruncated`. These locate the excerpt in the retained source revision;
they do not assert that the excerpt answers the question. Promoted memory output is unchanged.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Natural language search query |
| `limit` | number | | `5` | Max results per layer |
| `layers` | string[] | | both | `"episodic"`, `"promoted"`, or both |
| `tags` | string[] | | — | Filter to entries that include all specified tags |

**Examples:**

```
# Find past decisions about authentication
lcm_search(query: "authentication decision")

# Search only promoted memories, filtered by tag
lcm_search(query: "database migration", layers: ["promoted"], tags: ["type:decision"])
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
| `projectId` | string | | current project | The `project.id` of the search result the node came from. Required whenever the node did not come from this project, since node ids are only unique within one project |

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
| `projectId` | string | | current project | The `project.id` of the search result the node came from. Required whenever the node did not come from this project, since node ids are only unique within one project |

**Examples:**

```
# Expand a leaf summary one level deep
lcm_expand(nodeId: "sum_abc123")

# Expand a condensed summary, traversing two levels
lcm_expand(nodeId: "sum_def456", depth: 2)
```

### lcm_store

Store a memory into the promoted layer. Use to persist decisions, findings, reasoning outcomes, or any knowledge worth retrieving in future sessions.

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

# Vote that a surfaced memory still holds, naming the evidence
lcm_store(
  text: "Verified in bin/lcm.ts: imports still use .js extensions.",
  tags: ["signal:memory_vote", "vote:+1", "memory_id:<id>"]
)

# Vote that a surfaced memory is contradicted, naming what contradicts it
lcm_store(
  text: "src/cli/help.ts now lives at src/cli/help/index.ts — the path this memory names is gone.",
  tags: ["signal:memory_vote", "vote:-1", "memory_id:<id>"]
)
```

### Vote validation

A `signal:memory_vote` store is validated, not just recorded: exactly one `memory_id:<id>`
tag, exactly one `vote:+1` or `vote:-1` tag, and a non-empty `text` naming the evidence
(required on both `+1` and `-1`). A malformed vote is rejected with a message naming the
broken rule. The target memory may live in a sibling checkout of the same repository — the
store resolves it across the group the way `lcm_describe` resolves a `projectId` — and is
rejected if it can't be found (or is archived) anywhere in the group. A repeated identical
vote from the same session counts once; an opposite vote from the same session replaces the
earlier one. See `docs/tag-schema.md` for the full tag shape and `docs/configuration.md`
for how votes surface in `lcm stats`.

### lcm_stats

Show token savings, compression ratios, and usage statistics across all lcm projects.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `verbose` | boolean | | `false` | Include per-conversation breakdown |

Also reports, whenever either is non-empty: **Promotion candidates** — memories with
reported uses at or above `promotion.enforcementThreshold` (default 3), each with its text,
use count, `+1` count, `-1` count, and any objections — and **Contested** — memories with at
least one `-1`, with the reason for each. Both sections are always shown when non-empty,
independent of `verbose`: a human decides what to do with a candidate or an objection, lcm
only surfaces the counts. See `docs/configuration.md` for the threshold and how a contested
entry is resolved.

### lcm_doctor

Run diagnostics on the lcm installation. Checks daemon, hooks, MCP config, and summarizer health.

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
- Expansion is bounded by the requested `depth`; there is no token cap, so keep `depth` small
