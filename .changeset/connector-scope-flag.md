---
"@lossless-claude/lcm": patch
---

`lcm connectors install`, `remove`, `list` and `doctor` use Oh My Pi's global config (`<agentDir>`) only with `--global`. Without it they manage the project in the current directory, including a project whose root is the home directory: `~/.omp/hooks/post/lcm.ts` and `~/.omp/mcp.json`.
