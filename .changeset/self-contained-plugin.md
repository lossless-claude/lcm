---
"@lossless-claude/lcm": minor
---

feat: the Claude Code plugin is self-contained; Codex stays on the npm CLI

The plugin runs from a prebuilt `bundle/` committed at each release: hooks and the MCP server call `bundle/lcm.js` and `bundle/mcp-server.js` in exec form (`command` + `args`, no shell), so a marketplace install works with only `node` on PATH. No hook installs packages, compiles, or touches PATH any more. `lcm.mjs`, `mcp.mjs` and `.claude-plugin/lcm-mcp.sh` are removed, and `config.json` no longer carries `mcpNodePath`.

One daemon serves both distributions, newest wins: a newer caller restarts an older daemon; an older caller connects when the compatible component matches (the minor while 0.x, the major from 1.0) and warns once; an incompatible one fails open. A hook that cannot run exits 0 and writes one stderr line per session naming the repair command; `lcm doctor` reports the same conditions and checks the installed bundle.

`lcm install` now also provisions Codex globally when `codex` is on PATH, reports one outcome per harness, exits non-zero on any failure, and `--dry-run` writes nothing at all.

Releases: the version PR builds and commits `bundle/`; `publish.yml` only tags, publishes and creates the release as before.
