---
"@lossless-claude/lcm": patch
---

Keep SessionEnd within the exit budget by submitting directly without a health probe or daemon spawn, waiting only a short response grace, and recording submitted delivery when a busy daemon has not yet acknowledged. Preserve the older-daemon fallback within the same budget.
