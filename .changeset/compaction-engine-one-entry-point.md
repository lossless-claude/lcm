---
"@lossless-claude/lcm": patch
---

chore: `CompactionEngine` exposes only `compact`

`evaluate`, `compactLeaf` and `compactUntilUnder` had no caller and are
removed, together with the `maxRounds` config key and the `CompactionDecision`
type that only they used. `compactFullSweep` is folded into `compact` and
`evaluateLeafTrigger` is private to it.
`docs/architecture.md` describes the one sweep the daemon runs.
