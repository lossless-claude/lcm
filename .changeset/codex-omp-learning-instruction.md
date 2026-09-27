---
"@lossless-claude/lcm": patch
---

Codex and Oh My Pi agents now receive the learning instruction on every turn, worded for the `lcm` CLI: when to store, and how to report and vote on a surfaced memory. Codex gets it at the end of the `UserPromptSubmit` context; Oh My Pi gets it appended to the system prompt. Reinstall the Oh My Pi hook with `lcm connectors install omp`.
