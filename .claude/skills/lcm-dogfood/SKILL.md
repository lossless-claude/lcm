---
name: lcm-dogfood
description: Exercise a live lcm install (installed plugin, real summarizer, the user's own data) and report a scorecard. Usage: /lcm-dogfood [health|capture|import|compact|sensitive|mcp|integrity]
disable-model-invocation: true
---

# lcm dogfood

Proves what only a live install can: the installed plugin, the configured summarizer and the user's own memory working together. Hook output shapes, daemon-down behaviour and command options stay out of this skill; `test/e2e/` exercises them against an isolated daemon.

Run every phase, or only `$0`. The target is the real lcm home (`LCM_HOME`, default `~/.lossless-claude`):
- Phases that write (`compact`, `sensitive`, `mcp`) touch only the current project, or add and then remove their own entries. A run costs one project's summarization and keeps every existing summary; `--all` and `--restart` stay out of this skill.
- Phases that only read (`health`, `integrity`) cover the whole home.

Binary: `lcm` on PATH. Record each check as PASS, FAIL or SKIP (with the reason), keep going on FAIL, and open an issue for each failure worth tracking. The daemon log is `logs/daemon.log` in the lcm home, one JSON record per line; `docs/configuration.md` ("Daemon log") names its events.

## Phases

**health**: `lcm --version`, `lcm status`, `lcm doctor`. Done when the version equals `package.json`, the daemon is up on this project, and every doctor check passes or its warning is recorded. The `daemon-log` check covers errors and continuity in the daemon log.

**capture**: the plugin's hooks reaching the daemon. Done when the daemon log holds a `request` record for `POST /prompt-search` with `status` 200 and `cwd` equal to this project, written after this session started.

**import**: `lcm import --dry-run`. Done when it lists this project's sessions and `lcm status` shows the same message count before and after.

**compact**: note the time, then `lcm compact`, which compacts the current project and then promotes. The summarizer is an LLM call; allow five minutes. Done when:
- a second identical run creates nothing;
- the daemon log holds a `compact.done` or `compact.skipped` record for this project written after the noted time, and every `summarizer.fallback` record from that interval is noted in the scorecard with its `reason`;
- `lcm stats --verbose` agrees with the summary and promotion counts `lcm compact` printed.

**sensitive**: `lcm help sensitive`, then each subcommand. It writes the real pattern list, so remove every pattern you add. Done when a built-in secret and a pattern you added are both `[REDACTED]` by `lcm sensitive test`, and your pattern is gone from `lcm sensitive list`.

**mcp**: `docs/agent-tools.md` is the contract. Done when every tool it lists has been called with a documented parameter set and answered in the documented shape, including an `lcm_store` followed by an `lcm_search` that finds it. Skip `lcm_expand` and `lcm_describe` only when no summary id exists yet.

**integrity**: `node .claude/skills/lcm-dogfood/scripts/db-integrity.js`, which checks every project database read-only; on a large home it takes minutes. Done when it prints `N of N project databases ok`.

## Scorecard

One row per phase run: checks, PASS, FAIL, SKIP. For each FAIL: the error, the daemon log records around it, the suggested fix. Done when every phase you ran has a row.
