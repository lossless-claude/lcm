---
"@lossless-claude/lcm": patch
---

`lcm connectors` for Oh My Pi uses the global config only with `--global`. Run from a project whose root is the home directory, `install`, `remove`, `list` and `doctor` now manage `~/.omp/hooks/post/lcm.ts` and `~/.omp/mcp.json` instead of the files in `<agentDir>`.
