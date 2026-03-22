---
name: lcm-sensitive
description: Manage sensitive patterns for lossless-claude secret redaction — list, add, remove, test, or purge patterns.
user_invocable: true
---

# /lcm-sensitive

Manage the sensitive patterns used by lossless-claude to redact secrets before storing conversation messages.

## Usage

```
/lcm-sensitive list
/lcm-sensitive add <pattern>
/lcm-sensitive add --global <pattern>
/lcm-sensitive remove <pattern>
/lcm-sensitive test <text>
/lcm-sensitive purge [--all] --yes
```

## Instructions

Run the appropriate `lcm sensitive` subcommand via Bash based on the user's intent:

```bash
lcm sensitive list
lcm sensitive add "MY_SECRET_TOKEN"
lcm sensitive add --global "SHARED_API_KEY"
lcm sensitive remove "OLD_PATTERN"
lcm sensitive test "some text containing MY_SECRET_TOKEN"
lcm sensitive purge --yes
lcm sensitive purge --all --yes
```

### Subcommands

- **list** — Show all active patterns: built-in, global, and project-specific
- **add `<pattern>`** — Add a regex pattern to the current project's sensitive patterns file
- **add --global `<pattern>`** — Add a pattern to the global config (applies to all projects)
- **remove `<pattern>`** — Remove a pattern from the project's sensitive patterns file
- **test `<text>`** — Test what gets redacted from the given text (shows `[REDACTED]` substitutions)
- **purge** — Delete the current project's data directory (`~/.lossless-claude/projects/{hash}/`) (requires `--yes`)
- **purge --all** — Delete all project data directories under `~/.lossless-claude/projects/` (requires `--yes`)

All `purge` variants require `--yes` to confirm the destructive action.

### Pattern Guidelines

- Patterns are JavaScript-compatible regular expressions
- Prefer specific token patterns (e.g., `MY_APP_SECRET_[A-Z0-9]+`) over broad ones (e.g., `MY_APP.*`)
- Patterns containing spaces or `\s` are applied to full message text; others are applied per token
- Built-in patterns already cover common secrets: OpenAI keys, Anthropic keys, GitHub tokens, AWS keys, PEM keys, Bearer tokens, password assignments

Display the command output verbatim. If the command fails, show the error and suggest running `lcm doctor` to check installation health.
