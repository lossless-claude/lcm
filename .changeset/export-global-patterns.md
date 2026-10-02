---
"@lossless-claude/lcm": patch
---

`lcm knowledge export` now scrubs with `security.sensitivePatterns` from `config.json`, as capture, import and `/store` do. Before, a value matched only by a global pattern was written to the export file in plaintext.
