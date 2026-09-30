---
"@lossless-claude/lcm": patch
---

Preserve existing conversations when worker enrollment is refused, restrict enrollment to fresh starts, and ignore wire-supplied recovery markers. Keep lifecycle owners stable across Claude function-hook reloads and independent across Codex threads. Frame MCP and CLI jobs as untrusted data, shorten diagnostic worker ids, recognize copied claims through absolute CLI paths, and return undelivered claims to the queue.
