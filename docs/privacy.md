# Privacy & Data Handling

lcm stores your conversation history locally to enable memory across sessions. This document explains exactly what is stored, what leaves your machine, and how to control sensitive data.

## What is stored locally

All storage is on your machine:

- **`~/.lossless-claude/projects/{hash}/db.sqlite`** — Conversation messages, summaries, and promoted long-term memory for each project. The hash is a SHA-256 of the project directory path.
- **`~/.lossless-claude/projects/{hash}/sensitive-patterns.txt`** — Per-project sensitive patterns (if configured).
- **`~/.lossless-claude/events/{hash}.db`** — The passive-learning sidecar (see [passive-learning.md](passive-learning.md)): structured metadata extracted from tool calls and prompts. Raw tool input and output are not stored, except that an `AskUserQuestion` event keeps the truncated question and the answer you chose, which is the decision it exists to record. One extractor and one truncation rule cover both harnesses; a row also records `client` (`claude` or `codex`, the harness that produced it) and `model` (the model that issued the call, when known). Neither field changes what an extractor is allowed to read.
- **`~/.lossless-claude/config.json`** — Global configuration including the optional `security.sensitivePatterns` array.
- **`~/.lossless-claude/daemon.pid`** — Daemon process ID (transient).

No data is sent to any lcm server. There is no telemetry.

## What leaves your machine

lcm is a local runtime: nothing goes to any lcm server, and there is no telemetry.

The only component that can send data off your machine is the summarizer. Nothing is
configured out of the box, so `llm.provider` is `auto`, which means "use the CLI of the
harness that is running" — messages go to Anthropic via the `claude` CLI in a Claude
session (your Claude subscription), to OpenAI via `codex` in a Codex session, to GitHub via
`copilot` in a Copilot session. Set `llm.provider` to `disabled` to keep everything local.

| Summarizer (`llm.provider`) | Data sent externally |
|-----------------------------|----------------------|
| `auto` (default) | Whatever the running harness's CLI sends: Anthropic via `claude-process`, OpenAI via `codex-process`, GitHub via `copilot-process` |
| `disabled` | Nothing |
| `claude-process` | Messages sent to Anthropic via the `claude` CLI (your Claude subscription) |
| `codex-process` | Messages sent to OpenAI via the `codex` CLI (your OpenAI subscription) |
| `copilot-process` | Messages sent to GitHub via the `copilot` CLI (your Copilot subscription) |
| `anthropic` | Messages sent to Anthropic API (your API key) |
| `openai` | Messages sent to OpenAI API (your API key) |

When using an external summarizer, only the text being summarized is sent — not your full history. The summarizer receives a batch of recent messages to compress into a summary.

## Secret redaction

lcm scrubs secrets from message content **before writing to SQLite** and **before sending to the summarizer**. Redaction happens at both write points to ensure secrets are never persisted or transmitted.

### Built-in patterns

Two sets are always active, regardless of configuration:

- The **gitleaks** rule set, generated into `src/generated-patterns.ts` (204 patterns at the time of writing; `lcm sensitive list` prints the current count).
- A **native** set in `src/scrub.ts` that fills the gaps gitleaks covers only with surrounding context: bare OpenAI, Anthropic, GitHub, AWS, npm, Slack, Stripe, Google, SendGrid, Twilio, Shopify, Vault and Doppler tokens, PEM key headers, bearer tokens, password assignments, and database connection strings with embedded credentials.

Patterns are applied in this order: gitleaks, native, global user patterns, then project patterns. `lcm sensitive list` shows every active pattern with its source.

### Project-specific patterns

Add patterns for secrets specific to your project:

```bash
# Add a pattern (stored in ~/.lossless-claude/projects/{hash}/sensitive-patterns.txt)
lcm sensitive add "MY_APP_API_KEY_[A-Z0-9]+"

# Add a global pattern (applies to all projects, stored in config.json)
lcm sensitive add --global "CORP_INTERNAL_TOKEN"

# Test what gets redacted
lcm sensitive test "token=MY_APP_API_KEY_ABCDEF123"
# → token=[REDACTED]

# List all active patterns
lcm sensitive list
```

Patterns are JavaScript-compatible regular expressions. Use specific patterns (e.g., `MY_SECRET_[A-Z0-9]+`) rather than broad ones (e.g., `MY_.*`) to avoid over-redaction.

## Data retention

Messages and summaries persist until you explicitly remove them:

```bash
# Remove data for the current project
lcm sensitive purge --yes

# Remove lcm's hooks, MCP entry and daemon service (stored memory stays)
lcm uninstall

# Remove all lcm data
rm -rf ~/.lossless-claude
```

SQLite database files are stored in `~/.lossless-claude/projects/`. You can delete individual project directories manually to remove their history.

## Verifying your setup

```bash
lcm doctor
```

The `Security` section of the doctor output shows:
- How many built-in patterns are active
- Whether project-specific patterns are configured

## Summary

- All data is local — SQLite in `~/.lossless-claude/`.
- External summarizer (optional) receives only the text to be summarized, after scrubbing.
- Built-in patterns redact common secret formats automatically.
- Add project-specific patterns with `lcm sensitive add`.
- `lcm uninstall` removes lcm's hooks, MCP entry and daemon service; delete stored memory by removing `~/.lossless-claude/`.
