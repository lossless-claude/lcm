---
"@lossless-claude/lcm": patch
---

fix: the documented `LCM_*` tuning variables and `LCM_ENABLED` now take effect

`LCM_CONTEXT_THRESHOLD`, `LCM_FRESH_TAIL_COUNT`, `LCM_LEAF_MIN_FANOUT`,
`LCM_CONDENSED_MIN_FANOUT`, `LCM_CONDENSED_MIN_FANOUT_HARD`,
`LCM_INCREMENTAL_MAX_DEPTH`, `LCM_LEAF_CHUNK_TOKENS` and
`LCM_CONDENSED_TARGET_TOKENS` reach the compaction engine, and `LCM_ENABLED=false`
makes every hook a no-op. They were read by a resolver nothing called. The defaults
are the engine's existing values, so an environment that sets nothing behaves as
before; the README table now states those values.

Removed from the documentation, because nothing reads them: `LCM_LEAF_TARGET_TOKENS`,
`LCM_MAX_EXPAND_TOKENS`, `LCM_LARGE_FILE_TOKEN_THRESHOLD`, `LCM_AUTOCOMPACT_DISABLED`,
`LCM_SUMMARY_MODEL`.

The npm package ships the user-facing documents only, not the repository's
development notes.
