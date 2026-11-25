---
"@lossless-claude/lcm": patch
---

The function-hooks module no longer keeps the session claim while it cannot deliver anything. When the daemon refuses its token or cannot be reached even after a start, the module withdraws the claim and the command hooks record the session again, until the daemon accepts a module call. Tool calls that arrive while the module is starting the daemon now wait for that start and retry instead of being dropped, and a failed start no longer blocks the next attempt for a minute. After /clear, /resume, /branch or compaction, the module now sends the catch-up sweep that the silenced SessionStart command hook used to send.
