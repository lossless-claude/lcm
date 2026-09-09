---
"@lossless-claude/lcm": patch
---

The command hooks now stay silent only when the function-hooks module has actually claimed the session, not merely because `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. The module writes `<tmpdir>/lcm-claim-<session_id>.json` at `session.start`, and `lcm post-tool`, `lcm user-prompt` and `lcm session-snapshot` require both the variable and that claim before standing down. A module that fails to load no longer takes passive capture down with it: without a claim the command hooks record as they always did.
