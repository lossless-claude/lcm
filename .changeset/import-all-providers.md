---
"@lossless-claude/lcm": minor
---

`lcm import` imports every transcript source by default: Claude Code, Codex and OMP. It used to select only Claude Code unless `--replay` was given, so Codex and OMP sessions stayed out of memory until `--provider` was passed. Pass `--provider claude` (or `codex`, `omp`) to import one source.
