---
"@lossless-claude/lcm": patch
---

Oh My Pi agents can call lcm's MCP tools. `lcm connectors install omp --type mcp` adds the lcm server to `.omp/mcp.json`, or to `<agentDir>/mcp.json` with `--global`, and `lcm install` run from the npm CLI registers it globally next to the hook.

`lcm connectors install <agent> --type mcp` no longer replaces a config file that is not valid JSON, which dropped the servers it held; it stops and names the file. It also refuses to run from the Claude Code plugin, whose CLI path the next plugin update deletes.
