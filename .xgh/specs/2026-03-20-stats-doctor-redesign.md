# Stats & Doctor Output Redesign

**Date:** 2026-03-20
**Status:** Approved

## Problem

The current stats output frames metrics as "token savings" — comparing raw message tokens against summary tokens and reporting a percentage "saved." This is misleading because:

1. Claude Code's native compaction would also compress those messages — the user wouldn't have all raw tokens in context either way
2. Conversations with no summaries show "100% saved" (their raw tokens counted as saved when they were never actually summarized)
3. The "active projects" count was inflated by ghost DBs with empty conversations

The real value of lossless-claude is **memory persistence across sessions**, not token savings. The stats should reflect what the system actually remembers and how well it compresses.

## Design

### Two output paths

- **MCP tool output** (`lcm_stats`, `lcm_doctor`): proper markdown tables — Claude Code renders these beautifully
- **CLI output** (`lossless-claude stats`, `lossless-claude doctor`): clean aligned text with ANSI colors — no box-drawing characters

### Stats: `lcm_stats` / `lossless-claude stats`

Two sections: **Memory** (primary) and **Compression** (secondary, conditional).

#### Memory section (always shown)

| Metric | Source |
|---|---|
| Projects | Count of project dirs with `messages > 0` |
| Conversations | Total conversations across all projects |
| Messages | Total messages stored |
| Summaries | Total summaries in DAG |
| DAG depth | Max depth across all summaries |
| Promoted memories | Total entries in promoted table |

#### Compression section (shown only when summaries > 0)

Only counts conversations where `summaries > 0`. This ensures compression metrics reflect actual LLM-driven summarization, not unsummarized storage.

| Metric | Value format |
|---|---|
| Compacted | `{n} of {total} conversations` |
| Tokens | `{raw} -> {summary}` (arrow notation) |
| Ratio | `{ratio}x` |
| Bar | Visual compression bar with percentage on top |

Bar: `██████████████████████████████░` — filled = compressed away, empty = kept. Width: 30 chars. Green when ratio > 10x.

Percentage displayed on the line above the bar.

#### Verbose mode (per-conversation)

Adds a table of conversations **filtered to those with summaries only**. No more wall of dashes for unsummarized conversations.

Columns: `#`, `msgs`, `sums`, `depth`, `tokens` (arrow notation), `ratio`

### Doctor: `lcm_doctor` / `lossless-claude doctor`

Same two-path approach. Sections: Stack, Daemon, Settings, Result summary.

#### MCP output

Markdown tables with status icons inline:

```markdown
## Stack

| Check | Status |
|---|---|
| summarizer | claude-process |
| version | v0.3.0 |
| config | ~/.lossless-claude/config.json |
```

Status icons: checkmark, warning, x-mark — inline with the value text.

#### CLI output

Aligned text with ANSI colors and status icons. Same section headers as stats (`── Section ─────`). Result summary at bottom: `N passed . M failed . K warnings`.

### Shared visual elements

- Header: brain emoji + `lossless-claude`
- Section dividers: `── Name ──────────────────────────────` (cyan, consistent width)
- Dim labels, bold/normal values
- Green for positive metrics, yellow for warnings

### Data model changes

`OverallStats` interface:
- Add `compactedConversations: number` (count of conversations with `summaries > 0`)
- `rawTokens` / `summaryTokens` scoped to compacted conversations only
- `ratio` computed from compacted data only

### Data model details

`queryProjectStats()` must return `compactedConversations` (count where `summaries > 0`) so `collectStats()` can aggregate it across projects for the "Compacted: N of M" display.

The MCP verbose table must also filter to compacted-only conversations, same as CLI.

### Edge case: fresh install / 0 projects

Memory section shows all zeros. Compression section is hidden. No special "no data" message.

### Doctor check mapping

All existing checks survive. Each check becomes a row in its table section. The `fixApplied` flag renders as `(auto-fixed)` suffix on the status value. Auto-fix behavior is unchanged.

### Files to modify

| File | Change |
|---|---|
| `src/stats.ts` | Rewrite `printStats()`, update `collectStats()` and `queryProjectStats()` to track `compactedConversations`, add compression bar renderer |
| `src/mcp/server.ts` | Rewrite `lcm_stats` handler to output markdown tables with new framing, filter verbose to compacted-only |
| `src/doctor/doctor.ts` | Rewrite `printResults()` for CLI, `formatResultsPlain()` for MCP markdown tables, keep all existing checks |
| `.claude-plugin/commands/lossless-claude-stats.md` | Update slash command template to match new output structure |
| `.claude-plugin/commands/lossless-claude-doctor.md` | Update slash command template |
| `README.md` | Replace "60-90% token reduction" stats bar language with memory-first framing |
| `gh-pages/index.html` | Update stats bar section (remove "60-90% savings", reframe around memory persistence) |

### Language changes (global)

| Before | After |
|---|---|
| "Token Savings" | "Compression" |
| "Saved: N (X%)" | Removed — replaced by ratio + bar |
| "Raw tokens" / "Summary tokens" | "Tokens: raw -> summary" |
| "Active projects" | "Projects" |
| "Compression ratio" | "Ratio" |
| "60-90% token reduction" (website) | Reframe: e.g. "35x compression" or "every message preserved" |
| "token savings" / "savings" (README) | "compression" or remove |

### What the percentage and bar represent

The percentage = `(raw - summary) / raw * 100`. This is the compression ratio as a percentage — how much of the original content was compressed away. It's shown as a visual bar, not framed as "savings."

The bar fills from left to right: filled blocks = compressed away, empty blocks = kept as summary tokens.
