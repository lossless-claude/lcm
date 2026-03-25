# Passive Learning

Passive learning captures insights from your Claude Code sessions automatically — no manual `lcm_store()` calls needed. It observes tool usage patterns, user decisions, and session events, then promotes high-signal observations into cross-session memory.

## How It Works

### Event Capture

Two hooks capture events during your session:

- **PostToolUse** — fires after every tool call. Extracts structured metadata (tool name, command, file path) from tool inputs. Never captures raw tool output.
- **UserPromptSubmit** — fires on each user prompt. Detects decisions ("always use X"), role statements ("I'm a data scientist"), and intent patterns.

Events are written to a **sidecar SQLite database** (`~/.lossless-claude/events/<project-hash>.db`) at <10ms cost. This is separate from the main LCM database — if the daemon is unavailable, events are safely queued.

### What Gets Captured

| Category | Examples | Priority |
|----------|----------|----------|
| Decisions | User answers to AskUserQuestion, "always use TypeScript" | 1 (immediate) |
| Plan approvals | EnterPlanMode / ExitPlanMode events | 1 (immediate) |
| Errors | Bash commands that fail (isError: true) | 1 (immediate) |
| Git operations | Commits, merges, branch switches | 2 (batch) |
| Environment | `npm install`, `pip install`, `brew install` | 2 (batch) |
| File access | Read/Edit/Write/Glob/Grep with file paths | 3 (pattern-only) |
| MCP tools | Which MCP tools are used (tool name only) | 3 (pattern-only) |
| Skills | Which skills are invoked | 3 (pattern-only) |

### What Is NOT Captured

- Raw tool payload contents such as file contents and command stdout/stderr (only tool metadata and brief user answers are stored)
- Sensitive file paths (`.env`, `.ssh/`, `credentials`, `.npmrc`)
- LCM's own `lcm_store` calls (prevents feedback loops)

### Three-Tier Promotion

Events are promoted to cross-session memory at session boundaries (session-end, pre-compact, or next session start):

**Tier 1 — Immediate promotion** (priority 1): Decisions, plan approvals, and error→fix pairs are promoted directly with high confidence (0.4–0.7).

**Tier 2 — Batch promotion** (priority 2): Git and environment events are promoted with moderate confidence (0.3).

**Tier 3 — Pattern reinforcement** (priority 3): File access and tool usage events are only promoted if they match an existing entry in the promoted store. This prevents low-signal noise from flooding memory.

### Error→Fix Correlation

When a tool error is followed by a successful command with a matching prefix (within 20 events), the system correlates them as an error→fix pair. These are tagged `category:solution` and promoted with higher priority.

### Learned Insights

On SessionStart, recently promoted passive insights are surfaced in a `<learned-insights>` block. This closes the feedback loop — the system learns from your sessions and applies those learnings in future ones.

## Configuration

All thresholds are configurable in `~/.lossless-claude/config.json` under `compaction.promotionThresholds`:

```json
{
  "compaction": {
    "promotionThresholds": {
      "eventConfidence": {
        "decision": 0.5,
        "plan": 0.7,
        "errorFix": 0.4,
        "batch": 0.3,
        "pattern": 0.2
      },
      "reinforcementBoost": 0.3,
      "maxConfidence": 1.0,
      "insightsMaxAgeDays": 90
    }
  }
}
```

## Data Storage

- **Sidecar DB**: `~/.lossless-claude/events/<sha256-of-project-path>.db`
  - Per-project SQLite database in WAL mode
  - Processed events pruned after 7 days
  - Schema versioned for future migrations

- **Promoted store**: Events promoted via `deduplicateAndInsert()` into the main LCM database
  - Tagged with `source:passive-capture` and `hook:<PostToolUse|UserPromptSubmit>`
  - Searchable via `lcm search` and `lcm grep`
  - Deduplicated via BM25 matching

## Negative-Match Guards

The UserPromptSubmit extractor includes guards against false-positive decisions. Phrases like "don't worry", "never mind", "not sure", "doesn't matter", and "up to you" suppress decision extraction to prevent noise.

## Recovery

| Scenario | Behavior |
|----------|----------|
| Clean session end | Events promoted via `/promote-events` |
| Ctrl+C (SIGINT) | Stop hook triggers best-effort promotion |
| Pre-compact | Events promoted before context is compacted |
| Daemon unavailable | Events queued in sidecar, promoted next session |
| Hard kill (SIGKILL) | Events survive in sidecar, scavenged on next SessionStart |

## Observability

Passive learning activity is integrated into overall LCM statistics. Use `lcm stats` to inspect high-level promotion and compaction behavior.
