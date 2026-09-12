# Configuration guide

## Quick start

### Claude Code

Install the `lcm` binary and add the plugin:

```bash
npm install -g @lossless-claude/lcm  # provides the `lcm` command
claude plugin marketplace add lossless-claude/lcm
claude plugin install lcm@lossless-claude
lcm install
```

`lcm install` is the Claude Code setup path. It writes config, registers hooks, installs slash commands, registers MCP, and verifies the daemon.

#### MCP protocol revision

Claude Code opens a stdio server on the 2025-11-25 revision unless you ask it to
negotiate, and lcm serves both, so the tools work either way with nothing set. To use
the 2026-07-28 revision instead, set it in `~/.claude/settings.json`:

```json
{ "env": { "MCP_PROTOCOL_NEGOTIATION": "auto" } }
```

The variable is Claude Code's, not lcm's, and it applies to every stdio MCP server you
run. On the newer revision Claude Code asks the server what it supports before
connecting, and results carry the envelope described in
[agent-tools.md](./agent-tools.md); on the earlier one it connects directly. A server on
the newer revision cannot deliver Claude Code channel messages, so leave the variable
unset if you use lcm as a channel.

### VS Code (GitHub Copilot)

Install the repo-local connector:

```bash
npm install -g @lossless-claude/lcm
lcm connectors install github-copilot
lcm connectors doctor github-copilot
```

This writes `.agents/skills/lcm-memory/SKILL.md` in the current repository. Codex and Copilot both read that directory.

### Codex

Install the Codex connector:

```bash
npm install -g @lossless-claude/lcm
lcm connectors install codex
lcm connectors doctor codex
```

The default Codex connector writes native lifecycle hooks to `.codex/hooks.json`. Review their trust in Codex `/hooks`. Use `--global` for the user-wide configuration or `--type skill` for guidance only.

Import historical Codex sessions or replay both sources with:

```bash
lcm import --codex
lcm import --replay
```

For current limitations and the manual MCP step for Codex TOML config, see [`docs/vscode-codex.md`](vscode-codex.md).

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
export LCM_INCREMENTAL_MAX_DEPTH=-1
```

Restart Claude Code.

## Where lcm stores things

Everything lcm owns lives under `~/.lossless-claude`: the daemon's port, token and pid, one database per project, the events sidecars, and the logs.

`LCM_HOME` moves all of it:

```bash
LCM_HOME=/tmp/lcm-sandbox lcm daemon start --detach
LCM_HOME=/tmp/lcm-sandbox claude   # the function-hooks module reads the same variable
```

Use it to run lcm against a scratch directory without touching your own memory — trying a build before installing it, or reproducing a bug on a clean slate. Moving `HOME` instead would take the host's own configuration with it, and the session would not start.

Both the daemon and the client must see the same value: a daemon started without it answers on the port from `~/.lossless-claude/config.json` and writes to the real databases.

## Connector scope

The connector manager can install into either the current project or your global
agent config. For Codex, the global target is `~/.codex/`. GitHub Copilot is repo-scoped in this project today.

```bash
# Install the Codex skill globally instead of into the current repo
lcm connectors install codex --global

# Inspect or remove the global connector later
lcm connectors doctor --global
lcm connectors remove codex --global
```

Use the global flag when you want Codex to pick up the connector from your
user-level config rather than a single repository checkout.

`lcm install` does not configure VS Code or Codex connectors today. Use `lcm connectors install ...` for those clients.

## Tuning guide

The values below are read from the environment by the daemon when it starts,
and by the compaction engine it runs. After changing one, `lcm daemon restart`.
The defaults are the engine's own; leaving everything unset changes nothing.

### Context threshold

`LCM_CONTEXT_THRESHOLD` (default `0.75`) controls when compaction triggers as a fraction of the model's context window.

- **Lower values** (e.g., 0.5) trigger compaction earlier, keeping context smaller but doing more LLM calls for summarization.
- **Higher values** (e.g., 0.85) let conversations grow longer before compacting, reducing summarization cost but risking overflow with large model responses.

For most use cases, 0.75 is a good balance.

### Fresh tail count

`LCM_FRESH_TAIL_COUNT` (default `8`) is the number of most recent messages that are never compacted. These raw messages give the model immediate conversational continuity.

- **Smaller values** save context space for summaries but may lose recent nuance.
- **Larger values** (e.g., 32–64) give better continuity at the cost of a larger mandatory context floor.

### Leaf fanout

`LCM_LEAF_MIN_FANOUT` (default `3`) is the minimum number of raw messages that must be available outside the fresh tail before a leaf pass runs.

- Lower values create summaries more frequently (more, smaller summaries).
- Higher values create larger, more comprehensive summaries less often.

### Condensed fanout

`LCM_CONDENSED_MIN_FANOUT` (default `2`) controls how many same-depth summaries accumulate before they're condensed into a higher-level summary. `LCM_CONDENSED_MIN_FANOUT_HARD` (default `1`) is the relaxed minimum a hard-trigger (full) sweep uses instead.

- Lower values create deeper DAGs with more levels of abstraction.
- Higher values keep the DAG shallower but with more nodes at each level.

### Incremental max depth

`LCM_INCREMENTAL_MAX_DEPTH` (default `0`) controls whether condensation happens automatically after leaf passes.

- **0** — Only leaf summaries are created incrementally. Condensation only happens during manual `/compact` or overflow.
- **1** — After each leaf pass, attempt to condense d0 summaries into d1.
- **2+** — Deeper automatic condensation up to the specified depth.
- **-1** — Unlimited depth. Condensation cascades as deep as needed after each leaf pass. Recommended for long-running sessions.

### Summary target tokens

`LCM_CONDENSED_TARGET_TOKENS` (default `900`) is the target size of a condensed summary.

- Larger targets preserve more detail but consume more context space.
- Smaller targets are more aggressive, losing detail faster.

The actual summary size depends on the LLM's output; the value is a guideline passed in the prompt's token target instruction.

### Prompt recall budgeting

Prompt-time recall now has a second budget layer after `/prompt-search` ranking.

- `restoration.promptSearchMaxResults` still controls how many top-ranked results the route aims to consider first.
- `restoration.promptSnippetLength` still controls the per-result snippet size before final emission.
- `restoration.maxInjectedMemoryItems` caps how many deduped hints can survive into the final `<memory-context>` block.
- `restoration.dedupMinPrefix` dedupes identical or near-identical hints by normalized prefix before emission.
- `restoration.maxInjectedMemoryBytes` caps the final prompt-time memory injection budget.
- `restoration.reservedForLearningInstruction` reserves room for `<learning-instruction>` before any hints are emitted.

In practice, the hook asks the daemon for ranked candidates, the daemon dedupes and trims them against the final byte budget, and only the emitted hints get surfaced back to the hook. That means increasing `promptSearchMaxResults` without adjusting `maxInjectedMemoryBytes` just gives the reranker more candidates to choose from; it does not guarantee more emitted context.

### Leaf chunk tokens

`LCM_LEAF_CHUNK_TOKENS` (default `20000`) caps the amount of source material per leaf compaction pass.

- Larger chunks create more comprehensive summaries from more material.
- Smaller chunks create summaries more frequently from less material.
- This also affects the condensed minimum input threshold (10% of this value).

## Model selection

LCM defaults to `LCM_SUMMARY_PROVIDER=auto`.

- In Claude sessions, `auto` resolves to `claude-process`
- In Codex sessions, `auto` resolves to `codex-process`
- In Copilot sessions, `auto` resolves to `copilot-process` — no client identifies itself as `copilot` yet, so today you select it with `LCM_SUMMARY_PROVIDER=copilot-process`
- If you explicitly set `LCM_SUMMARY_PROVIDER`, that override applies to both CLIs

The provider can be pinned from the environment; the model only from `~/.lossless-claude/config.json`:

```bash
export LCM_SUMMARY_PROVIDER=anthropic
export LCM_SUMMARY_API_KEY=<key>   # required by the anthropic provider
```

```json
{ "llm": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" } }
```

Valid provider values are:

- `auto`
- `claude-process`
- `codex-process`
- `copilot-process`
- `anthropic`
- `openai`
- `disabled`
- `session` (early access, see below)

### Session provider

`llm.provider: "session"` asks the live Claude Code session that owns the transcript to run each summarization through its own client, via lcm's function-hooks module (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`; see `docs/hook-protocol.md`). Leaf chunks go to `haiku` through `$.model.complete`; condensed nodes go through `$.model.fork`, so the session's own model sees the whole conversation. Tokens are charged to the session's Claude account.

```json
{ "llm": { "provider": "session", "fallbackProvider": "claude-process" } }
```

- `llm.fallbackProvider` answers a job the session does not serve within 20 s (no module loaded, session gone, spend cap reached, or an error). Any provider except `session` is valid. When absent, the `auto` resolution above applies. A provider you name explicitly in `llm.provider` is never replaced by the session path.
- The module spends at most `sessionSummarizerMaxOutputTokens` output tokens per session; set it in the plugin's `userConfig` (default 50000, 0 disables serving jobs).
- Usage is recorded as `session:haiku` or `session:fork`; `complete` calls have estimated token counts, counted in `llm_usage_stats.calls_estimated`.

### Reasoning parameter

The `openai` provider sends `llm.reasoning` verbatim with each chat completion
request, for models that reason by default and would otherwise spend the whole
output budget thinking:

```json
{ "llm": { "provider": "openai", "reasoning": { "effort": "minimal" } } }
```

The value is forwarded untouched, so the accepted shape is whatever the model
behind your OpenAI-compatible endpoint accepts: GLM 5.3 Flash honours
`{"effort":"minimal"}` and rejects `{"enabled":false}`; Qwen3.7 Flash honours only
`{"enabled":false}`; Mercury 2.5 honours `effort`. When unset, no `reasoning` key
is sent.

`llm.reasoning` is read only by the `openai` provider — `anthropic` and the
process-backed providers ignore it silently. It must be a JSON object: a string,
an array, `null` or a number is rejected at config load, not at request time.

### Token cost reporting

Every provider reports its usage in a normalized shape, stored in
`llm_usage_stats` and shown by `lcm import --replay` and `lcm stats`:

| Provider | Input | Cached | Output | Extra |
|---|---|---|---|---|
| `claude-process` | yes | yes | yes | list-price cost in USD |
| `codex-process` | yes | yes | yes | — |
| `copilot-process` | no | no | yes | premium requests |
| `openai` | yes | when the server reports it | yes | real charged cost, OpenRouter only |
| `anthropic` | yes | yes | yes | — |

Every provider charges; only the Claude CLI and OpenRouter report the charge
back as a number. A missing cost therefore means *unknown*, never *free*.
Against an OpenRouter base URL the `openai` provider asks for cost accounting
explicitly, because OpenRouter omits the figure otherwise.

The reported charge is stored in `llm_usage_stats.cost_usd_total`, alongside
`calls_with_cost` — how many of the recorded calls carried a price. The column
is left NULL, and `lcm import --replay` prints `unknown`, when nothing reported
one; a partially priced run is printed as "N of M calls priced" so a partial
total cannot pass for the run's full cost.

`inputTokens` always counts the full prompt, with `cachedInputTokens` as a subset
of it, so totals are comparable across providers. The Copilot CLI only exposes
prompt-token counts in its text output mode, which hard-wraps the summary and is
therefore unusable here — it reports output tokens and GitHub premium requests
instead.

Copilot bills per request, not per token: every call costs about 0.33 premium
requests regardless of size, so a compaction over N chunks costs roughly
N × 0.33. LCM runs it with no tools, no MCP servers and no repo instructions,
which keeps the prompt around 6k tokens instead of the ~26k a default session
spends on tool schemas alone.

Using a cheaper or faster model for summarization can reduce costs, but quality matters because poor summaries compound as they are condensed into higher-level nodes.

## Stale memory review

Promoted memories stay active indefinitely unless manually archived. Over time, some become stale: old project knowledge that is no longer correct or useful, but keeps surfacing.

LCM identifies stale candidates by combining age with recall feedback signals:

- **Age threshold** (`restoration.staleAfterDays`, default 90): memories older than this are evaluated for staleness.
- **Surfacing without use** (`restoration.staleSurfacingWithoutUseLimit`, default 5): if a memory has been surfaced this many times without ever being acted upon, it is a stale candidate.
- **Restore age limit** (`restoration.restoreMaxPromotedAgeDays`, default 180): the restore route suppresses promoted memories older than this.
- **Stale penalty** (`restoration.stalePenalty`, default 0.5): score penalty applied to stale candidates during prompt-time ranking.
- **Strong match override** (`restoration.allowStaleOnStrongMatch`, default true): when enabled, stale memories can still surface if their relevance score is high enough despite the penalty.

### Inspecting stale candidates

Call the `/review-stale` daemon endpoint with `{ "cwd": "/path/to/project" }` to list stale candidates with their surfacing and usage counts.

### Archiving and reviving

Stale candidates can be archived non-destructively. Archived memories are excluded from search and recall but remain in the database and can be revived later.

The `/review-stale` endpoint accepts `action: "archive"` or `action: "revive"` with a `target_id` to manage individual memories.

### Stats integration

Run `lcm stats --verbose` to see a summary of stale memory candidates across all projects.


## Database management

Each project's SQLite database lives at `~/.lossless-claude/projects/<sha256-of-project-path>/db.sqlite`. The per-project path is derived automatically from the working directory.

### Inspecting the database

```bash
# Find your project hash
lcm stats

# Open the database (replace <hash> with your project hash)
sqlite3 ~/.lossless-claude/projects/<hash>/db.sqlite

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

The database is a single file per project. Back it up with:

```bash
cp ~/.lossless-claude/projects/<hash>/db.sqlite ~/.lossless-claude/projects/<hash>/db.sqlite.backup
```

Or use SQLite's online backup:

```bash
sqlite3 ~/.lossless-claude/projects/<hash>/db.sqlite ".backup /tmp/lcm-backup.sqlite"
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

Or set `LCM_ENABLED=false` to make every Claude Code and Codex command hook a no-op while keeping the plugin registered.

To keep capture and recall but stop the automatic compaction at session end, set `hooks.disableAutoCompact` in `~/.lossless-claude/config.json`:

```json
{
  "hooks": { "disableAutoCompact": true }
}
```
