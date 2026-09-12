# MCP registrations measure their node interpreter instead of naming one

**Status:** accepted, 2026-09-12. Scopes #424. The launcher-script half is superseded by
[self-contained-plugin.md](self-contained-plugin.md), 2026-09-13.

lcm registers its MCP server in two places, and each had its own way of depending on
`PATH` to find an interpreter. `.claude-plugin/plugin.json` (tracked) ran
`node ${CLAUDE_PLUGIN_ROOT}/mcp.mjs` — depends on `PATH` resolving `node`. The
installer's writes into an agent's own (untracked) config —
`~/.claude/settings.json`, `.mcp.json`, `.qwen/mcp.json` — registered bare `lcm`,
which depends on `PATH` resolving the `lcm` shim *and* that shim's
`#!/usr/bin/env node` shebang resolving `node`. Two dependencies, not one, on a
machine where a session's `PATH` (nvm, volta, a Homebrew shim, a plugin runtime's own
sandboxed spawn) may not match the shell where `lcm` was installed.

## Three alternatives considered

| # | Approach | Why not |
|---|---|---|
| 1 | Write the absolute node/CLI path directly into `plugin.json` | `plugin.json` is tracked. An absolute path is per-machine, per-user data; committing it would work for exactly the machine that last ran `npm run build` and break for everyone else who clones the repo. |
| 2 | A launcher that guesses via `$NVM_DIR`, volta, or common Homebrew paths | Every guess is a maintenance surface that drifts from whatever version managers actually do next, and it still fails silently (falls through every guess) with no measured fact to fall back to — it's guessing with extra steps, not resolving. |
| 3 (chosen) | Record the node path lcm's own hooks already ran under, in **per-machine, untracked** config, and read it from a tracked static launcher | The value is measured, not guessed — it's `process.execPath` from a process that just ran successfully — and it lives where per-machine state already lives, never in a tracked file. |

## The two entries today

| entry | tracked | how it finds node |
|---|---|---|
| `.claude-plugin/plugin.json` → `plugin:lcm:lcm` | yes | exec form, `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bundle/mcp-server.js"]`. Claude Code resolves `node` itself, the same way it resolves the interpreter for every plugin hook, so the registration has no dependency of its own. The former `.claude-plugin/lcm-mcp.sh` launcher, which read a recorded `mcpNodePath` out of `config.json`, is gone with its only reader; `config.json` no longer carries that key. |
| an agent's own MCP config (`~/.claude/settings.json`, `.mcp.json`, …) | no | [`src/installer/mcp-server-entry.ts`](../../src/installer/mcp-server-entry.ts) returns `process.execPath` (absolute) plus the absolute path to the CLI of the running build (`src/cli-entrypoint.ts`: `bundle/lcm.js` from the plugin, `dist/bin/lcm.js` from npm), both measured from the node process running the installer at write time |

Precedent already in the repo: `src/connectors/codex-hooks.ts`'s `buildCodexHookCommand`
does `options.nodePath ?? process.execPath` and writes the resolved path into Codex's
own (untracked) `hooks.json`. Same technique, same reason, applied to the second
entry; `mcp-server-entry.ts` is the equivalent for the three call sites that write an
MCP registration (`src/connectors/installer.ts`, `installer/install.ts`,
`src/doctor/doctor.ts`).

## Why the tracked file never carries a path

`plugin.json` is committed. Writing `process.execPath` into it would encode *this
machine's* node path into a file every clone and every CI run shares — exactly the
defect this note is about, moved one file over. The tracked file names `node` and a
path relative to the plugin root; everything absolute lives in untracked, per-machine
config the installer writes at runtime.

## Windows

Zero `win32` branches exist anywhere in `src/`, and `package.json` has no `os` field.
Exec form needs no shell, so the plugin's hooks and MCP entry run on Windows with a
`node.exe` on PATH; `lcm install`'s `command -v` probes still assume `sh`.
