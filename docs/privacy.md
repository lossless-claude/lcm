# Privacy & Data Handling

lcm stores your conversation history locally to enable memory across sessions. This document explains exactly what is stored, what leaves your machine, and how to control sensitive data.

## What is stored locally

All storage is on your machine:

- **`~/.lossless-claude/projects/{hash}/db.sqlite`** — Conversation messages, summaries, and promoted long-term memory for each project. The hash is a SHA-256 of the project directory path.
- **`~/.lossless-claude/projects/{hash}/sensitive-patterns.txt`** — Per-project sensitive patterns (if configured).
- **`~/.lossless-claude/config.json`** — Global configuration including the optional `security.sensitivePatterns` array.
- **`~/.lossless-claude/daemon.pid`** — Daemon process ID (transient).

No data is sent to any lcm server. There is no telemetry.

## What leaves your machine

lcm is a local runtime. By default, **nothing leaves your machine**.

The exception is the summarizer, which you configure explicitly:

| Summarizer (`llm.provider`) | Data sent externally |
|-----------------------------|----------------------|
| `disabled` (default) | Nothing |
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

- The **gitleaks** rule set, generated into `src/generated-patterns.ts` (221 patterns at the time of writing; `lcm sensitive list` prints the current count).
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

# Remove all lcm data
lcm uninstall
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
- Delete your data with `lcm uninstall` or by removing `~/.lossless-claude/`.
