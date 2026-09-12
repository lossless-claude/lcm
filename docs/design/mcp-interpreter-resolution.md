# The MCP launcher measures its node interpreter instead of naming one

**Status:** accepted, 2026-09-12. Scopes #424.

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
| 3 (chosen) | Record the node path lcm's own hooks already ran under, in **per-machine, untracked** config; a tracked static launcher reads it, falling back to `PATH` | The value is measured, not guessed — it's `process.execPath` from a process that just ran successfully — and it lives where per-machine state already lives (`~/.lossless-claude/config.json`, or `$LCM_HOME`), never in a tracked file. |

## The two fixes, one per entry

| entry | tracked | fix |
|---|---|---|
| `.claude-plugin/plugin.json` → `plugin:lcm:lcm` | yes | `command` points at [`.claude-plugin/lcm-mcp.sh`](../../.claude-plugin/lcm-mcp.sh): a static script carrying no machine data, which reads `mcpNodePath` out of `config.json` and `exec`s it, falling back to `command -v node` |
| an agent's own MCP config (`~/.claude/settings.json`, `.mcp.json`, …) | no | [`src/installer/mcp-server-entry.ts`](../../src/installer/mcp-server-entry.ts) returns `process.execPath` (absolute) plus the absolute path to the installed `dist/bin/lcm.js`, both measured from the node process running the installer at write time |

Precedent already in the repo: `src/connectors/codex-hooks.ts`'s `buildCodexHookCommand`
does `options.nodePath ?? process.execPath` and writes the resolved path into Codex's
own (untracked) `hooks.json`. Same technique, same reason, applied here to the second
entry; `mcp-server-entry.ts` is the equivalent for the three call sites that write an
MCP registration (`src/connectors/installer.ts`, `installer/install.ts`,
`src/doctor/doctor.ts` — all three previously built the entry independently, one of
them, `resolveBinaryPath`, still via `command -v lcm`).

## Why the launcher script, not a second absolute-path write

`plugin.json` is committed. Writing `process.execPath` into it would encode *this
machine's* node path into a file every clone and every CI run shares — exactly the
defect this issue is about, moved one file over. The static `.sh` is the part that's
safe to commit; the absolute path it needs is the part that isn't, so it stays in
config the tracked file only reads at runtime.

## The chicken-and-egg boundary

The node path is recorded by `ensureCore` (`src/bootstrap.ts`), which runs on every
hook dispatch — already executing under a node that just worked, since it's the node
that ran this hook. Those hooks are themselves invoked by `plugin.json` as bare
`node ${CLAUDE_PLUGIN_ROOT}/lcm.mjs ...` (out of scope for this issue — a separate,
lower-severity instance of the same class of bug, since Claude Code itself resolves
that `node`, not a shim `lcm` installed). On a machine that has never run any lcm hook,
`config.json` has no `mcpNodePath` yet, and the launcher falls back to `command -v
node` — identical to today's behavior, so this is not a regression on first run.

## Windows

Zero `win32` branches exist anywhere in `src/`, and `package.json` has no `os` field,
so a `.sh` launcher drops no platform lcm supports today. A future Windows port needs
a `.cmd` (or PowerShell) twin of `lcm-mcp.sh` alongside it — not addressed here.
