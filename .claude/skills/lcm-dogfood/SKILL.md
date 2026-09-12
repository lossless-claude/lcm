---
name: lcm-dogfood
description: Exercise the lcm public surface in a live session and report a scorecard. Usage: /lcm-dogfood [health|import|compact|promote|sensitive|hooks|mcp|resilience|debug]
disable-model-invocation: true
---

# lcm dogfood

Run every phase, or only `$0`. The CLI's own help is the checklist: for each command,
`lcm help <command>` names the options, and the phase passes when every documented option
ran and did what the help says. Nothing in this file lists options or counts, so it cannot
go stale; the help can.

Binary: `lcm` on PATH, or `node dist/bin/lcm.js` after `npm run build`. Large output goes
through `ctx_execute`; short output through Bash. Record each check as PASS, FAIL or SKIP
(with the reason), keep going on FAIL, and open an issue for each failure worth tracking.

## Phases

**health**: `lcm status`, `lcm doctor`, `lcm --version`. Done when the daemon is up on this
project, every doctor check passes or its warning is recorded, and the version equals
`package.json`.

**import**: `lcm help import`, then every option. Done when a second identical run adds no
message beyond the current session's own.

**compact**: `lcm help compact`, then every option. The summarizer is an LLM call; allow
five minutes. Done when a second identical run creates nothing.

**promote**: `lcm help promote`, then `lcm stats --verbose`. Done when the promoted count
moved, or the output states there was nothing promotable, and the stats agree with the
counts the earlier phases printed.

**sensitive**: `lcm help sensitive`, then every subcommand. Done when a built-in secret and
a pattern you added are both `[REDACTED]` by `lcm sensitive test`, and the pattern you added
is gone from `lcm sensitive list` after you removed it.

**hooks**: `docs/hook-protocol.md` is the contract. Done when every hook command it lists
answers a valid stdin payload with the output shape it documents, within its timeout, and
the daemon's `/prompt-search` answers `scripts/prompt-search-test.js <query>` directly.

**mcp**: `docs/agent-tools.md` is the contract. Done when every tool it lists has been
called with a documented parameter set and answered in the documented shape, including a
`lcm_store` followed by an `lcm_search` that finds it. Skip `lcm_expand` and `lcm_describe`
only when no summary id exists yet.

**resilience**: stop the daemon (`lcm daemon stop`), then `lcm status`, a hook command, and
`lcm daemon start --detach`. Done when the down state is reported without a hang, the hook
returns within its timeout with empty or valid output, and status shows the daemon up
again.

**debug**: `~/.lossless-claude/daemon.log` tail, `scripts/db-integrity.js`, and `$PWD`
against `pwd`. Done when no ERROR line is unexplained, every project database reports
`ok`, and the two paths match.

## Scorecard

One row per phase run: checks, PASS, FAIL, SKIP. For each FAIL: the error, the daemon log
excerpt, the suggested fix. Done when every phase you ran has a row.
