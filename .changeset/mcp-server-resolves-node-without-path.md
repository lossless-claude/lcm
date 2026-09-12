---
"@lossless-claude/lcm": patch
---

fix: the MCP server no longer depends on PATH to resolve node

The plugin's MCP entry ran bare `node`, and the untracked entry lcm writes into an
agent's own config (`~/.claude/settings.json`, `.mcp.json`, …) ran bare `lcm` —
which itself depends on PATH resolving `node` via its shebang. Either could fail with
`CONNECTION_CLOSED` and no clue why on a session whose PATH doesn't match the shell
`lcm` was installed from (nvm, volta, a Homebrew shim, a sandboxed plugin runtime).

`plugin.json` now points at `.claude-plugin/lcm-mcp.sh`, a static, tracked launcher
that reads the node interpreter lcm's own hooks already recorded in
`~/.lossless-claude/config.json` (`mcpNodePath`, written by `ensureCore` from
`process.execPath`), falling back to `command -v node` when nothing is recorded yet.
The entry lcm writes into an agent's own config now carries `process.execPath` and
the absolute path to the installed `dist/bin/lcm.js`, both measured at install time —
naming neither `lcm` nor `node` by name. See
`docs/design/mcp-interpreter-resolution.md`.
