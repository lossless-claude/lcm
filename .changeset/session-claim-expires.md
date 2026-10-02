---
"@lossless-claude/lcm": patch
---

On Claude Code 2.1.287 and later, which load the function-hooks module by default, exactly one path now captures events and delivers memory per session: the command hooks stand down whenever the module has claimed the session, with or without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`. The module rewrites its claim before each command hook that reads it runs, withdraws it at `session.end`, and a claim older than 60 seconds no longer counts, so a session where the module did not load, including one resumed after a crash, keeps the command hooks working. After `/clear`, `/resume` or `/branch` the module claims the new session id too, so the restored memory reaches the model once instead of twice.
