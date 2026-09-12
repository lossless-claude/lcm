---
"@lossless-claude/lcm": patch
---

fix: one storing rule across every guidance surface

`~/.claude/lcm.md` banned manual storing while the connector skill made `lcm store` mandatory on every code task. Every generated surface now states the same rule: store durable insights (decision, preference, root-cause, pattern, gotcha, solution, workflow) explicitly, tagged with `type:`, one concise insight and its why per store.
