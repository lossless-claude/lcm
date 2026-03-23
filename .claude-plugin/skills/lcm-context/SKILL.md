---
name: lcm-context
description: "Use when deciding which lcm MCP tool to call — lcm_search, lcm_grep, lcm_expand, lcm_describe, lcm_store, lcm_doctor, or lcm_stats — or when an lcm tool returns an error."
---

# lcm Memory Tool Guide

Lossless-claude provides 7 MCP tools. This skill helps you pick the right one and recover from errors.

> **Hooks already inject memory at session start.** Do NOT re-query what was already injected. This skill is for active retrieval, storage, and error recovery — not session initialization.

## Tool Decision Tree

### Retrieval Tools (search → grep → expand)

These three tools **chain** from broad to deep:

1. **lcm_search** — Broad concept recall across sessions
   - Use: "how was auth implemented?", "what decisions were made about compaction?"
   - Returns: ranked results from FTS5 + semantic layers
   - Options: `tags` to filter, `layers` to scope (episodic/semantic)

2. **lcm_grep** — Exact keyword/regex in raw transcripts
   - Use: "JWT", "socket.unref", specific error messages
   - Returns: matching messages/summaries with context
   - Options: `scope` (messages/summaries/all), `since` date filter

3. **lcm_expand** — Drill into a compressed summary node
   - Use: when a search/grep result references a summary nodeId and you need the full content
   - Returns: decompressed source content from the DAG
   - Options: `depth` to control traversal levels

**Chaining pattern:** Start with `lcm_search` for broad recall → use `lcm_grep` to find exact references → use `lcm_expand` to decompress interesting nodes.

### Inspection Tool

4. **lcm_describe** — Check a node's metadata without loading content
   - Use: when a nodeId came from grep and you don't know if it's worth expanding. Saves tokens if the node is stale, shallow, or unrelated.
   - Returns: depth, token count, parent/child links, promotion status

### Storage Tool

5. **lcm_store** — Persist a decision or finding for future sessions
   - Use: architectural decisions, bug root causes, user preferences, integration patterns
   - Options: `tags` for categorization, `metadata` for project/session context

### Operational Tools

6. **lcm_doctor** — Check system health (daemon, hooks, MCP, summarizer)
7. **lcm_stats** — View compression ratios and token savings

## When to Use / When NOT to Use

### Retrieval
**Use when:**
- You need context that wasn't in the hook-injected summary
- You're looking for a specific past decision or conversation
- A summary node looks relevant but needs more detail

**Do NOT use when:**
- The information is already in your current context (hook injected it)
- You're looking for general knowledge, not project memory
- You can answer from code/git alone

### Storage
**Use when:**
- An architectural decision was made with rationale worth preserving
- A bug root cause was identified (the "why", not just the fix)
- User expressed a preference or feedback that affects future work
- A non-obvious integration pattern was discovered

**Do NOT use when:**
- The information is already in git (code, commit messages)
- It's a transient debugging step or ephemeral task detail
- It's already documented in CLAUDE.md or memory files
- It's general knowledge, not project-specific

## Error Self-Healing

### Agent-Fixable (handle automatically)

| Error | Recovery |
|---|---|
| Daemon not running | Run `lcm daemon start --detach` via Bash, then retry |
| "No results" from search | Try `lcm_grep` with different keywords, or broaden the query |
| Node not found on expand | Use `lcm_search` to find the correct nodeId |
| Store succeeds but daemon restarted before SessionEnd | Call `lcm_doctor` to verify persistence; re-store if the node is missing |

### User Action Required (surface to user)

| Error | What to tell the user |
|---|---|
| MCP server disconnected | Restart the session, then run `/lcm-diagnose` to audit for gaps |
| Hooks not firing | Call `lcm_doctor` to confirm; if hooks are missing, tell user to run `lcm install` |
| Summarizer failing | Tell user to run `/lcm-doctor` for full diagnostics |

## Quick Reference

```
lcm_search  → broad concept recall (FTS5 + semantic)
lcm_grep    → exact keyword/regex match
lcm_expand  → decompress a summary node
lcm_describe → inspect node metadata (check before expanding)
lcm_store   → persist decisions/findings
lcm_doctor  → health check
lcm_stats   → compression metrics
```
