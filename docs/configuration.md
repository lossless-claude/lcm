# Configuration guide

## Quick start

Clone the repo and link it with Claude Code's plugin installer:

```bash
git clone https://github.com/lossless-claude/lcm.git
cd lcm
npm install
npm run build
claude plugins install --link /path/to/lossless-claude
```

`claude plugins install --link` handles plugin registration/enabling and slot selection automatically.

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
export LCM_INCREMENTAL_MAX_DEPTH=-1
```

Restart Claude Code.

## Tuning guide

### Context threshold

`LCM_CONTEXT_THRESHOLD` (default `0.75`) controls when compaction triggers as a fraction of the model's context window.

- **Lower values** (e.g., 0.5) trigger compaction earlier, keeping context smaller but doing more LLM calls for summarization.
- **Higher values** (e.g., 0.85) let conversations grow longer before compacting, reducing summarization cost but risking overflow with large model responses.

For most use cases, 0.75 is a good balance.

### Fresh tail count

`LCM_FRESH_TAIL_COUNT` (default `32`) is the number of most recent messages that are never compacted. These raw messages give the model immediate conversational continuity.

- **Smaller values** (e.g., 8–16) save context space for summaries but may lose recent nuance.
- **Larger values** (e.g., 32–64) give better continuity at the cost of a larger mandatory context floor.

For coding conversations with tool calls (which generate many messages per logical turn), 32 is recommended.

### Leaf fanout

`LCM_LEAF_MIN_FANOUT` (default `8`) is the minimum number of raw messages that must be available outside the fresh tail before a leaf pass runs.

- Lower values create summaries more frequently (more, smaller summaries).
- Higher values create larger, more comprehensive summaries less often.

### Condensed fanout

`LCM_CONDENSED_MIN_FANOUT` (default `4`) controls how many same-depth summaries accumulate before they're condensed into a higher-level summary.

- Lower values create deeper DAGs with more levels of abstraction.
- Higher values keep the DAG shallower but with more nodes at each level.

### Incremental max depth

`LCM_INCREMENTAL_MAX_DEPTH` (default `0`) controls whether condensation happens automatically after leaf passes.

- **0** — Only leaf summaries are created incrementally. Condensation only happens during manual `/compact` or overflow.
- **1** — After each leaf pass, attempt to condense d0 summaries into d1.
- **2+** — Deeper automatic condensation up to the specified depth.
- **-1** — Unlimited depth. Condensation cascades as deep as needed after each leaf pass. Recommended for long-running sessions.

### Summary target tokens

`LCM_LEAF_TARGET_TOKENS` (default `1200`) and `LCM_CONDENSED_TARGET_TOKENS` (default `2000`) control the target size of generated summaries.

- Larger targets preserve more detail but consume more context space.
- Smaller targets are more aggressive, losing detail faster.

The actual summary size depends on the LLM's output; these values are guidelines passed in the prompt's token target instruction.

### Leaf chunk tokens

`LCM_LEAF_CHUNK_TOKENS` (default `20000`) caps the amount of source material per leaf compaction pass.

- Larger chunks create more comprehensive summaries from more material.
- Smaller chunks create summaries more frequently from less material.
- This also affects the condensed minimum input threshold (10% of this value).

## Model selection

LCM defaults to `LCM_SUMMARY_PROVIDER=auto`.

- In Claude sessions, `auto` resolves to `claude-process`
- In Codex sessions, `auto` resolves to `codex-process`
- If you explicitly set `LCM_SUMMARY_PROVIDER`, that override applies to both CLIs

You can pin a specific summarizer provider and model:

```bash
# Use a specific provider + model for summarization
export LCM_SUMMARY_MODEL=anthropic/claude-sonnet-4-20250514
export LCM_SUMMARY_PROVIDER=anthropic
```

Valid provider values are:

- `auto`
- `claude-process`
- `codex-process`
- `anthropic`
- `openai`
- `disabled`

Using a cheaper or faster model for summarization can reduce costs, but quality matters because poor summaries compound as they are condensed into higher-level nodes.


## Database management

The SQLite database lives at `LCM_DATABASE_PATH` (default `~/.claude/lcm.db`). 

### Inspecting the database

```bash
sqlite3 ~/.claude/lcm.db

# Count conversations
SELECT COUNT(*) FROM conversations;

# See context items for a conversation
SELECT * FROM context_items WHERE conversation_id = 1 ORDER BY ordinal;

# Check summary depth distribution
SELECT depth, COUNT(*) FROM summaries GROUP BY depth;

# Find large summaries
SELECT summary_id, depth, token_count FROM summaries ORDER BY token_count DESC LIMIT 10;
```

### Backup

The database is a single file. Back it up with:

```bash
cp ~/.claude/lcm.db ~/.claude/lcm.db.backup
```

Or use SQLite's online backup:

```bash
sqlite3 ~/.claude/lcm.db ".backup ~/.claude/lcm.db.backup"
```

## Per-agent configuration

In multi-agent Claude Code setups, each agent uses the same LCM database but has its own conversations (keyed by session ID). The plugin config applies globally; per-agent overrides use environment variables set in the agent's config.

## Disabling LCM

To fall back to Claude Code's built-in compaction:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

Or set `LCM_ENABLED=false` to disable the plugin while keeping it registered.
