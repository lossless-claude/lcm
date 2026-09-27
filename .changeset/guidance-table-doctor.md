---
"@lossless-claude/lcm": patch
---

`lcm doctor` checks the memory guidance each installed harness receives. With `codex` on PATH it warns when the Codex hooks are missing and reports whether the MCP server is registered; with `omp` on PATH it warns when the Oh My Pi hook or MCP server is missing. `lcm doctor` and `lcm connectors doctor omp` also report an Oh My Pi hook that differs from the one this version ships, since the installed hook is a copy that an upgrade does not change.
