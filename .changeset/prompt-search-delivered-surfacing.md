---
"@lossless-claude/lcm": patch
---

`/prompt-search` now records a hint as surfaced only once its answer has been handed to the socket. A client that closes the connection before the answer is sent, as the command hooks, the Codex hooks and the OMP extension do when they time out, no longer puts the hints it never showed into cooldown or towards the unused-surfacing penalty, so they can surface on the next prompt. The function-hooks module is not covered yet: its timeout stops the wait but leaves the connection open, so an answer that comes after it is still sent and still counts as surfaced. Prompt events are still recorded first, whether or not the answer is delivered.
