---
"@lossless-claude/lcm": minor
---

feat: passive-learning events record client and model provenance; Codex captures PostToolUse

Every event in the passive-learning sidecar now carries `client` (`claude` or `codex`, the harness that produced it — existing rows read back as `claude`) and `model` (the model that issued the tool call). Codex's `PostToolUse` / `PostToolUseFailure` hook payload carries its model when the host sends one; Claude Code's never does, so that column stays null until the session's transcript is next ingested, which backfills it by matching each tool call's id.

`lcm codex-hook` now handles `PostToolUse` and `PostToolUseFailure`: the payload's field names already match the shape `src/hooks/extractors.ts` consumes for Claude Code, so one extractor, one allowlist and one truncation rule cover both harnesses, and it writes straight to the project's local sidecar with no daemon round trip. `lcm connectors install codex` registers the two new hooks; reinstalling stays idempotent.

What this does not yet cover, for a native Codex host: a `tool_name` Codex serializes under its own name rather than Claude Code's (`apply_patch`, `exec_command`) matches no extractor branch, so it produces no event; and a payload that omits `model` leaves the column null, because the per-turn transcript backfill exists for Claude Code only.
