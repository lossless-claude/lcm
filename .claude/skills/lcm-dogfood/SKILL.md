---
name: lcm-dogfood
description: Exercise a live lcm install (installed plugin, real summarizer, the user's own data) and report a scorecard. Usage: /lcm-dogfood [health|capture|import|compact|sensitive|mcp|integrity]
disable-model-invocation: true
---

# lcm dogfood

Proves what only a live install can: the installed plugin, the configured summarizer and the user's own memory working together. Hook output shapes, daemon-down behaviour and command options stay out of this skill; `test/e2e/` exercises them against an isolated daemon.

Run every phase, or only `$0`. The target is the real lcm home (`LCM_HOME`, default `~/.lossless-claude`):
- Phases that write (`compact`, `sensitive`, `mcp`) touch only the current project, or add and then remove their own entries. A run costs one project's summarization and keeps every existing summary; `--all` and `--restart` stay out of this skill.
- `integrity` only reads, across the whole home.
- `lcm doctor` (in `health`, and `lcm_doctor` in `mcp`) repairs lcm's own setup when it finds it drifted: the hooks and MCP entries in `~/.claude/settings.json`, `~/.claude/lcm.md`, a stale daemon. Each repair prints as a fixed warning; record it in the scorecard as a finding, since a live install that needed one had drifted.

Binary: `lcm` on PATH. Record each check as PASS, FAIL or SKIP (with the reason), keep going on FAIL, and open an issue for each failure worth tracking. The daemon log is `logs/daemon.log` in the lcm home, one JSON record per line; `docs/configuration.md` ("Daemon log") names its events.

## Phases

**health**: `lcm --version`, `lcm status`, `lcm doctor`. Done when the version equals `package.json`, the daemon is up on this project, and every doctor check passes or its warning (or repair) is recorded. The `daemon-log` check covers errors and continuity in the daemon log.

The running daemon's log level decides what `capture` and `compact` can find. `daemon.start` is written at every level; any other `info` record after the last `daemon.start` shows the running daemon writes `info`. Without one, the level is `warn` or higher: mark the checks for `info` records (the `/prompt-search` request, `compact.done`, `compact.skipped`) SKIP with that reason. `summarizer.fallback` is a `warn` record and is checked at any level.

**capture**: the plugin's hooks reaching the daemon from this session. To find this session's id, echo a unique marker (such as `dogfood-` plus the epoch seconds) in one command, then, in the next, search this project's directory under `~/.claude/projects/` recursively for `*.jsonl` files containing it. The one file that holds it is this session's transcript, and its name without `.jsonl` is the session id. Done when the daemon log holds a `request` record for `POST /prompt-search` with `status` 200, `cwd` equal to this project and `session_id` equal to this session's id.

**import**: `lcm import --dry-run --verbose`. Done when it lists this project's sessions and `lcm status` shows the same message count before and after.

**compact**: note the time and the `Summaries` and `Promoted` counts `lcm status` shows for this project, then `lcm compact`, which compacts the current project and then promotes. The summarizer is an LLM call; allow five minutes. Done when:
- a second identical run creates nothing;
- either `lcm compact` printed that there was nothing to compact (it then sends no request, so the log has no record), or the daemon log holds a `compact.done` or `compact.skipped` record for this project written after the noted time;
- every `summarizer.fallback` record from that interval is noted in the scorecard with its `reason`;
- `lcm status` afterwards shows this project's `Summaries` count higher than before when the log holds a `compact.done` for this run, and unchanged otherwise; `Promoted` is never lower than before. `lcm stats` totals every project, so it cannot confirm one project's counts.

**sensitive**: `list`, `add`, `test` and `remove`, from `lcm help sensitive`. It writes the real pattern list, so remove every pattern you add. `purge` deletes stored memory, so this skill never runs it. Done when a built-in secret and a pattern you added are both `[REDACTED]` by `lcm sensitive test`, and your pattern is gone from `lcm sensitive list`.

**mcp**: `docs/agent-tools.md` is the contract. Done when every tool it lists has been called with a documented parameter set and answered in the documented shape, including an `lcm_store` followed by an `lcm_search` that finds it. Skip `lcm_expand` and `lcm_describe` only when no summary id exists yet.

**integrity**: `node .claude/skills/lcm-dogfood/scripts/db-integrity.js`, which checks every project database read-only; on a large home it takes minutes. Done when it prints `N of N project databases ok`.

## Scorecard

One row per phase run: checks, PASS, FAIL, SKIP. For each FAIL: the error, the daemon log records around it, the suggested fix. Done when every phase you ran has a row.
