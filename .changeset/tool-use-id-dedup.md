---
"@lossless-claude/lcm": patch
---

Passive-learning events now dedup on `(session_id, tool_use_id)`. Both the command hook and the function-hooks module receive Claude Code's call id, so a session that runs both paths records each tool call once instead of twice. Events schema v4 adds the column and its index; a database written before it migrates on open.
