---
"@lossless-claude/lcm": minor
---

OMP sessions now summarize through a `omp-process` provider that spawns the `omp` CLI itself, the same way Codex and Copilot sessions already do. `LCM_SUMMARY_PROVIDER=auto` in an OMP session now resolves to it instead of falling through to `claude-process`, which an OMP-only machine does not have. `lcm doctor` checks for the `omp` CLI the same way it checks for `codex` and `copilot`.
