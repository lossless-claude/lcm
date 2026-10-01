---
"@lossless-claude/lcm": patch
---

Resume capture after a paginated Codex subagent rewrite whose parsed messages exactly match the stored tail, preserving stored history. Record other paginated recovery mismatches once as terminal session guards, skip later reads and report them in doctor.
