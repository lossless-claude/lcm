---
"@lossless-claude/lcm": minor
---

Retain scrubbed tool-call inputs and result outcomes beside unchanged Claude, Codex and OMP message rows. Commands and MCP JSON are capped at 2 KB; file writes retain paths and byte size, and subagent calls retain type and description without prompts. Incremental capture updates later results, transcript event-time repair backfills existing calls, and full-text search finds stored commands.
