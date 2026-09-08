---
"@lossless-claude/lcm": minor
---

First function-hooks module (Claude Code early access, behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). One `tool.call` hook in `hooks/lcm-hooks.ts` replaces the PostToolUse and PostToolUseFailure command hooks: it runs after the tool, reads success or failure from the result, and posts the call to the daemon's new `POST /tool-event` route, which writes the same passive-learning rows the command hook wrote. No `node` process is spawned per tool call any more when the module is loaded. While the flag is set, `lcm post-tool` stays silent so nothing is recorded twice; the test suite clears the flag so a developer's own session cannot change its results.
