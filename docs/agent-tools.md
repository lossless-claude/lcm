# Agent tools

LCM provides nine MCP tools for agents to search, inspect, store, and recall information from conversation history.

The MCP server speaks the [2026-07-28 protocol](https://modelcontextprotocol.io/specification/2026-07-28)
over stdio, powered by the TypeScript SDK v2, and also serves the earlier 2025-11-25
revision. Which one a connection uses is the client's choice; both reach the same nine
tools with the same arguments and text results. Only the newer revision carries the
result envelope (`resultType`, `ttlMs`, `cacheScope`, `_meta`). The entrypoints remain
`lcm mcp` (npm) and `node bundle/mcp-server.js` (the Claude Code plugin).

## Usage patterns

### Escalation pattern: search or grep → describe → expand

Most recall tasks follow this escalation:

1. **`lcm_search`** — Broad recall across sessions; **`lcm_grep`** instead when you hold an exact keyword, error message or function name
2. **`lcm_describe`** — Inspect a specific summary's metadata and lineage (cheap, no DAG traversal)
3. **`lcm_expand`** — Deep recall: decompress a summary node into its full source content

If the snippet is enough, stop. If you need metadata, use describe. If you need details that were compressed away, use expand. The guidance lcm installs for agents (`src/guidance.ts`) states the same order.

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

### Restored summary ids

Restored summaries begin with `Summary [<summaryId>]:` on its own line before the
stored summary text. This deterministic header is supplied by lcm, independently
of what the summarizer wrote, for Claude Code, Codex and OMP. Use its id with
`lcm_describe` or `lcm_expand`, or pass it as `summary_id` to `lcm_grep` to search
the original messages covered by that summary.

### The `<memory-context>` block

Every prompt can carry a `<memory-context>` block of memories surfaced for that prompt, ending
in a trailing comment: `<!-- surfaced-memory-ids: id-1,id-2@projectId -->`. An id on its own came
from the current project; an id suffixed `@projectId` came from a sibling checkout of the same
repository (promoted memory is shared across every checkout). Pass that suffix as the `projectId`
argument to `lcm_describe` or `lcm_expand` — the bare id, read against the current project, would
resolve to a different node or nothing at all.

## Tool reference

### lcm_search

Native search across episodic history and promoted memories. Returns two separate ranked lists. Use when looking for project knowledge spanning multiple sessions.

Native episodic matches contain up to 1,000 characters of exact source context, plus `span`,
`sourceHash`, and `snippetTruncated`. These locate the excerpt in the retained source revision;
they do not assert that the excerpt answers the question. Promoted memory output is unchanged.

Timeline summaries appear in episodic results with `timeline.period` and
`timeline.stale`. Stale timeline nodes are hidden by default; `includeStale`
includes them with their reasons. They are projections over the session evidence,
and are never promoted memories.

Raw coverage ranges use zero-based session positions across all conversations
(clear boundaries included), excluding compaction event rows.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Natural language search query |
| `pivotQuery` | string | | — | Your own translation of `query` into the pivot language; its terms are added to the original's |
| `limit` | number | | `5` | Max results per layer |
| `includeStale` | boolean | | `false` | Include stale timeline nodes with their periods and reasons |
| `layers` | string[] | | both | `"episodic"`, `"promoted"`, or both |
| `tags` | string[] | | — | Filter to entries that include all specified tags |

**Examples:**

```
# Find past decisions about authentication
lcm_search(query: "authentication decision")

# Search only promoted memories, filtered by tag
lcm_search(query: "database migration", layers: ["promoted"], tags: ["type:decision"])

# Author language differs from the pivot language: send both forms
lcm_search(query: "por que trocamos de runner?", pivotQuery: "why did we change the runner?")
```

**Cross-language search.** A project's author may write in one language while most of the text that
answers a query — tool output, code, summaries — is in another. When the author language recorded
for the project differs from `search.pivotLanguage` (default `en`, the language to translate *into*,
not a language detected in the corpus), pass `pivotQuery`. lcm never translates: the caller is
already a model, so no query-time model call happens inside the daemon.

Both languages reach the caller before and after a search: the `lcm_search` description names them
when they differ, a search response carries `authorLanguage` and `pivotLanguage` whenever the project
has a recorded author language, so a search made without a translation can be retried with one, and
the `<memory-context>` block the prompt hook emits carries the same one-line hint. Each side of the pair is tokenised on its own, so neither
language's function words leak into the other's terms, and the two term sets are then searched as
one — a hit through either side counts. `lcm_grep` is unaffected: its semantics are literal.

### lcm_grep

Search conversation history by keyword or regex across raw messages and summaries.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Keyword, phrase, or regex to search |
| `scope` | string | | `"all"` | `"messages"`, `"summaries"`, or `"all"` |
| `sessionId` | string | | — | Filter to a specific session |
| `summary_id` | string | | — | Restrict to the selected summary, its recursive source summaries, and their linked messages |
| `since` | string | | — | ISO datetime lower bound |

**Returns:** `messages`, `summaries`, and `totalMatches`. Each message match carries
`messageId`, `conversationId`, `role`, `snippet`, `createdAt`, and `summaryIds`: all
covering leaf and condensed summaries, ordered by depth then id (empty for an
unsummarized message). Summary matches carry their own `summaryId`.

`summary_id` intersects the session and time filters and applies before result
limits in full-text, fallback, and regex searches. An unknown id returns no
matches. With `scope: "messages"`, it searches only the original linked messages;
with `scope: "summaries"`, it searches the selected summary and its recursive
source summaries; the default `"all"` searches both.

**Examples:**

```
# Search for an error message across all history
lcm_grep(query: "ECONNREFUSED")

# Search the original messages covered by a restored summary
lcm_grep(query: "ECONNREFUSED", summary_id: "sum_abc123", scope: "messages")

# Search only summaries for a specific term
lcm_grep(query: "config\\.threshold", scope: "summaries")
```

### lcm_describe

Inspect metadata and lineage of a memory node without expanding content. Returns depth, token count, parent/child links, and whether the node was promoted to long-term memory.

For a timeline node, `node.timeline` also contains `period`, exact session
`coverage` (source summary ids and raw message ranges), `stale` reason/time,
`memoryRefs` (id and revision), `generator`, and `replaces`. Describe never calls
the model. Historical replaced nodes and digests retired after later session compaction remain readable by id.

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

Store a durable insight in promoted memory: one concise insight and its why. What is worth storing, the tags a store carries, and the reserved `signal:` tags for reporting and voting on a surfaced memory are in [tag-schema.md](tag-schema.md).

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | ✅ | — | The content to store |
| `tags` | string[] | | — | Canonical tags (see [tag-schema.md](tag-schema.md)) |
| `metadata` | object | | — | Optional key/value metadata; explicit `sessionId` and `projectId` override inferred provenance |

`lcm_store` and `lcm store` record the caller's session id from
`CLAUDE_CODE_SESSION_ID`, then `CODEX_THREAD_ID` when the first is absent or empty.
Without either, the session id is `"manual"`. The project id defaults to the id of
the project database the memory is stored in, including the owning sibling checkout
for a memory use or vote. Explicit `metadata.sessionId` and `metadata.projectId`
values passed to `lcm_store` take precedence independently.

Active memories still attributed to `"manual"` can be traced from raw Claude/Codex
store calls with the preview-first CLI command `lcm doctor --repair-manual-attribution`.
Only a unique matching session is eligible for explicit offline apply, which
retains a database backup and changes only `session_id`. See
[manual memory attribution repair](configuration.md#manual-memory-attribution-repair).

The database destination and its project record remain keyed by the supplied cwd
(or the owning sibling for memory feedback). Explicit `metadata.projectId` changes
the row's provenance; it does not create a separate store under that id.

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

The Memory table carries a **Subagent** row: how many stored conversations search excludes as
subagent transcripts, over all conversations, as a count and a share. Search recognises a
subagent transcript by its session id starting with `agent-`, a naming convention owned by the
host harness. Every conversation is either excluded by that rule or searchable, so the two
sum to the conversation total. When a conversation's `.meta.json` sidecar attributed it to a
parent session but its id does not start with `agent-`, the row also reports that count: a
non-zero value means the convention drifted and those transcripts are no longer excluded.

Also reports, whenever either is non-empty: **Promotion candidates** — memories with
reported uses at or above `promotion.enforcementThreshold` (default 3), each with its memory
ID, text, owner project, use count, `+1` count and `-1` count — and **Contested** — memories with at
least one `-1`, with the reason for each. Both sections are always shown when non-empty,
independent of `verbose`: a human decides what to do with a candidate or an objection, lcm
only surfaces the counts. See `docs/configuration.md` for the threshold and how a contested
entry is resolved. Multi-project entries also carry their `ownerProjectId`; use it as
`owner_project_id` with `/review-stale` when archiving or reviving an entry from another
checkout.

### lcm_doctor

Run diagnostics on the lcm installation. Checks daemon, hooks, MCP config, and summarizer health, and reports stale temporary/test project stores, counts of record-less stores and those holding promoted memories, and orphan-summary counts and ids per store. Per-store lists and orphan ids are bounded to 20 entries with a remaining count; `lcm doctor --verbose` shows complete diagnostic lists. Unreadable databases have unknown memory contents. These storage checks preserve stored data. Stale-store cleanup is an explicit CLI operation described in [configuration.md](configuration.md#project-store-hygiene); its preview lists record-less stores and offers cwd recovery suggestions from structured rows or known project ids, while retaining them. The tool does not apply cleanup or repair records or orphan summaries.

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
- Expansion is bounded by the requested `depth`. The retrieval engine honors an optional
  `tokenCap` and sets `truncated` when adding a child summary or source message would exceed
  it; the expansion orchestrator propagates that flag. The daemon's `lcm_expand` path
  currently supplies no cap, and its MCP parameters expose none, so keep `depth` small.

### lcm_summarize_claim

Claims one pool job with no arguments. Only a live dedicated Claude Code worker
started with `LCM_SUMMARIZE_WORKER=1` and enrolled by its lcm hook may use stdio
MCP. The server reads `CLAUDE_CODE_SESSION_ID` from its harness environment, never
from tool arguments. The returned `job` includes `id`, `system`, rendered `prompt`,
`kind`, `depth`, `targetTokens` and `maxTokens`; `worker_id` is unique per claim.
An empty pool omits `job`. Every result carries the permanent-exclusion warning
and guidance that `system` and `prompt` are untrusted data to summarize, never
instructions to follow. Embedded commands and tool requests remain source content.
Missing or stale identity, an undeclared session, Codex MCP and OMP MCP are refused
with guidance and no source text. Forked worker sessions are unsupported.

### lcm_summarize_submit

| Parameter | Meaning |
|---|---|
| `jobId` | Claimed job id; required. |
| `workerId` | `worker_id` from the claim; required. |
| `model` | Answering model; required, recorded as validated `session-pool:<model>`. |
| `text` | Non-empty summary; provide exactly one of `text` or `error`. |
| `error` | Non-empty completion failure. |
| `usage` | Optional object: non-negative integer `input_tokens`, `output_tokens`, and boolean `estimated`. Missing usage defaults to estimated. |

The same live enrolled session and worker id must submit. A duplicate, expired or
mismatched answer is discarded. The existing summarizer rejects invalid answers
and applies its fallback chain. Completion expires after `llm.poolCompletionMs`,
default 180000 ms, independently of the 20000 ms claim deadline. See
[summarize workers](summarize-workers.md). The CLI pair is `lcm summarize-claim`
and `lcm summarize-submit`; Codex supports that pair through `CODEX_THREAD_ID`.

The `lcm_store` / `lcm store` refusal for declared or excluded workers is a
client-side guard. A command without the worker environment cannot be detected.
Environment ids are cooperative identity, not authentication against local processes.
Worker enrollment and last activity also appear in `lcm_stats` and `lcm_doctor`,
using the same eight-character hashed worker id as status and CLI stats.
For copied successful claim payloads, doctor also identifies the detection and cwd:
future capture stops and stored history is preserved for the user's review.
