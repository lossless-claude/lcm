---
"@lossless-claude/lcm": patch
---

Oh My Pi agents can call lcm's MCP tools. `lcm connectors install omp --type mcp` adds the lcm server to `.omp/mcp.json`, or to `<agentDir>/mcp.json` with `--global`, and `lcm install` run from the npm CLI registers it globally next to the hook.
