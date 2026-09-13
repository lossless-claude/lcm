---
"@lossless-claude/lcm": minor
---

feat: passive-learning events record client and model provenance; Codex captures PostToolUse

Every event in the passive-learning sidecar now carries `client` (`claude` or `codex`, the harness that produced it — existing rows read back as `claude`) and `model` (the model that issued the tool call). Codex's `PostToolUse` / `PostToolUseFailure` hook payload carries its model directly; Claude Code's does not, so that column stays null until the session's transcript is next ingested, which backfills it by matching each tool call's id.

`lcm codex-hook` now handles `PostToolUse` and `PostToolUseFailure`: a normalizer maps Codex's payload onto the same shape `src/hooks/extractors.ts` already consumes for Claude Code, so one extractor, one allowlist and one truncation rule cover both harnesses, and it writes straight to the project's local sidecar with no daemon round trip. `lcm connectors install codex` registers the two new hooks; reinstalling stays idempotent.
