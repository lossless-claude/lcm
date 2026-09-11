---
"@lossless-claude/lcm": patch
---

Serve both MCP protocol revisions rather than only 2026-07-28. Claude Code opens a stdio
server on 2025-11-25 unless `MCP_PROTOCOL_NEGOTIATION` is set to `auto`, so refusing that
opening left the seven tools unreachable under the default. Both revisions now reach the
same tools with the same results.
