# Configuration

lossless-claude is configured through environment variables and a JSON config file. All settings have sensible defaults — most users don't need to change anything.

## Config file

`~/.lossless-claude/config.json` is created by `lcm install`. You can edit it directly or use environment variable overrides.

## Environment variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Set to `false` to disable the plugin while keeping it registered |
| `LCM_DATABASE_PATH` | `~/.claude/lcm.db` | Path to the SQLite database |

### Compaction thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction. Lower = more frequent, higher = larger conversations before compacting |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of most recent messages never compacted. Provides immediate conversational continuity |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages outside fresh tail before a leaf pass runs |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Same-depth summaries needed before condensation |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | Max condensation depth after each leaf pass. `0` = leaf only, `-1` = unlimited |
| `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction pass |

### Summary sizing

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_LEAF_TARGET_TOKENS` | `1200` | Target size for leaf summaries |
| `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target size for condensed summaries |

These are guidelines passed in the summarizer prompt. Actual sizes depend on LLM output.

### Summarizer

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_SUMMARY_PROVIDER` | `auto` | Which LLM provider to use for summarization |
| `LCM_SUMMARY_MODEL` | — | Pin a specific model (e.g., `anthropic/claude-sonnet-4-20250514`) |

**Provider values:**

| Provider | Behavior |
|----------|----------|
| `auto` | Resolves to `claude-process` in Claude sessions, `codex-process` in Codex sessions |
| `claude-process` | Uses the Claude CLI's built-in model access |
| `codex-process` | Uses the Codex CLI's built-in model access |
| `anthropic` | Direct Anthropic API (requires `ANTHROPIC_API_KEY`) |
| `openai` | Direct OpenAI API (requires `OPENAI_API_KEY`) |
| `disabled` | No summarization — messages accumulate without compaction |

Using a cheaper model for summarization reduces costs, but quality matters because poor summaries compound as they're condensed into higher-level nodes.

### Passive learning

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_PASSIVE_LEARNING` | `true` | Enable automatic event capture from tool use and user prompts |

Passive learning thresholds are configured in `config.json` under `compaction.promotionThresholds`:

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

## Tuning recommendations

**For coding conversations** (many tool calls per turn): Keep `LCM_FRESH_TAIL_COUNT=32` and set `LCM_INCREMENTAL_MAX_DEPTH=-1` for unlimited condensation depth.

**For long-running sessions**: Higher `LCM_CONTEXT_THRESHOLD` (e.g., 0.85) lets conversations grow longer before compacting, reducing summarization cost.

**For aggressive memory savings**: Lower `LCM_LEAF_TARGET_TOKENS` and `LCM_CONDENSED_TARGET_TOKENS` produce smaller summaries at the cost of lost detail.

## Sensitive patterns

lossless-claude scrubs secrets from messages before writing to SQLite and before sending to the summarizer.

### Built-in patterns (always active)

| Pattern | Example |
|---------|---------|
| OpenAI secret key | `sk-...` |
| Anthropic API key | `sk-ant-...` |
| GitHub PAT | `ghp_...` |
| AWS access key ID | `AKIA...` |
| PEM private key | `-----BEGIN ... KEY-----` |
| Bearer token | `Authorization: Bearer ...` |
| Password assignment | `password=...`, `PASSWORD: ...` |

### Custom patterns

```bash
# Add a project-specific pattern
lcm sensitive add "MY_APP_KEY_[A-Z0-9]+"

# Add a global pattern (all projects)
lcm sensitive add --global "CORP_TOKEN"

# Test what gets redacted
lcm sensitive test "token=MY_APP_KEY_ABCDEF"
# → token=[REDACTED]

# List all active patterns
lcm sensitive list
```

Patterns are JavaScript-compatible regular expressions. Prefer specific patterns over broad ones to avoid over-redaction.

## Database management

The SQLite database lives at `LCM_DATABASE_PATH` (default `~/.claude/lcm.db`).

```bash
# Inspect
sqlite3 ~/.claude/lcm.db "SELECT COUNT(*) FROM conversations;"
sqlite3 ~/.claude/lcm.db "SELECT depth, COUNT(*) FROM summaries GROUP BY depth;"

# Backup
sqlite3 ~/.claude/lcm.db ".backup ~/.claude/lcm.db.backup"
```

## Disabling LCM

To fall back to Claude Code's built-in compaction:

```bash
export LCM_ENABLED=false
```

Or set the context engine slot in your plugin config:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

## Authentication

LCM resolves summarizer credentials through a three-tier cascade:

1. **Auth profiles** — Claude Code's OAuth/token/API-key profile system
2. **Environment variables** — Standard provider env vars (`ANTHROPIC_API_KEY`, etc.)
3. **Custom provider key** — From models config

For OAuth providers (e.g., Anthropic via Claude Max), LCM handles token refresh automatically.
