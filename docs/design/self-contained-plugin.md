# The Claude Code plugin is self-contained; Codex stays on the npm CLI

**Status:** accepted, 2026-09-13. Supersedes the launcher half of
[mcp-interpreter-resolution.md](mcp-interpreter-resolution.md).

Lifecycle hooks never install packages, compile, or mutate PATH. The Claude Code
plugin runs from what the marketplace fetched; Codex keeps the npm CLI. One daemon
and one store serve both.

## Bundle

`npm run build:bundle` (`scripts/build-bundle.mjs`, esbuild) emits the plugin
artifact:

| File | Role |
|---|---|
| `bundle/lcm.js` | the CLI: every hook command, `daemon start`, `doctor`, `install` |
| `bundle/mcp-server.js` | the MCP server |
| `bundle/assets/` | prompt YAML, connector templates, `setup.sh` |

`.claude-plugin/plugin.json` calls the bundle in exec form: `"command": "node",
"args": ["${CLAUDE_PLUGIN_ROOT}/bundle/lcm.js", "restore"]`. No shell is involved,
so Windows does not need Git Bash, and nothing on the hook path runs `npm`.
`lcm.mjs`, `mcp.mjs` and `.claude-plugin/lcm-mcp.sh` are gone.

Two things the bundle cannot find at runtime are injected at build time as the
defines `__PKG_VERSION__` and `__BUILD_ID__`: from `bundle/` neither `package.json`
nor `dist/BUILD_ID` is reachable, and an undefined version silently disables the
daemon ownership check. The build id is read from `dist/BUILD_ID`, so the bundle
and the npm package of one build report the same fingerprint. The define names
carry underscores because esbuild replaces free identifiers only: a define named
`PKG_VERSION` would be shadowed by the module that exports `PKG_VERSION`.

The optional LLM SDKs (`@anthropic-ai/sdk`, `openai`) are bundled, not
externalised: without code splitting esbuild inlines the dynamically imported
provider modules and hoists their imports to the top level, so an external SDK
would make the whole bundle fail to load on every plugin install.

Everything that resolved a path from `import.meta.url` now resolves from wherever
it runs: `src/cli-entrypoint.ts` prefers a sibling `lcm.js` (bundle) and falls back
to `../bin/lcm.js` (dist); the prompt loader and template service prefer `assets/`
next to the module. The daemon is spawned as `process.execPath` +
`process.argv[1] daemon start --automatic`, so `bundle/lcm.js` is the daemon entry
with no extra file.

`dist/` remains the npm artifact and `npm run build` never touches `bundle/`:
otherwise every developer PR would dirty it. `bundle/` changes only in version PRs
(below), and `.gitattributes` marks it binary so those diffs stay readable.

## One daemon, newest wins

Both distributions talk to the same daemon and store, so `isStaleDaemon` compares
semver instead of equality (`daemonOwnership` in `src/daemon/lifecycle.ts`):

| Caller vs daemon | Verdict |
|---|---|
| newer | `restart`: the caller replaces the daemon |
| same version, different build | `restart` |
| older, same compatible component | `older-caller`: connect and warn once |
| older, different compatible component | `incompatible`: fail open, never restart |

The compatible component is the minor while the package is at 0.x (0.12 and 0.13
are incompatible) and the major from 1.0.

Hooks pass only the version, never the build id. The plugin bundle and the npm
CLI of one release are built in different CI runs; if their build ids ever
differed and both passed them, Claude Code hooks and Codex hooks would restart the
daemon at each other. The build id is compared only where it was before: `lcm
doctor` and the `lcm daemon start` hint.

## Fail open, with one line

The first hook of a session runs `ensureCore` and writes its verdict into the
session's bootstrap flag; every later hook reads the flag back
(`ensureBootstrapped`, `src/bootstrap.ts`). When the daemon did not start, or is
newer, the first hook writes one line on stderr naming the command that repairs
it: `lcm daemon start`, or the update command for this distribution (`claude
plugin update lcm@lossless-claude` from `bundle/lcm.js`, `npm install -g
@lossless-claude/lcm@latest` otherwise; `src/hooks/fail-open.ts`). An
incompatible daemon marks the session unusable: every hook then exits 0 with
nothing on stdout. `lcm doctor` reports the same three conditions, and checks
that the installed plugin carries `bundle/lcm.js`.

A missing bundle cannot exit 0: node itself exits 1 before lcm runs, since there
is no launcher any more. That case is reported by `lcm doctor` (`plugin-bundle`)
and is closed by `claude plugin update`.

## `lcm install`

- Claude Code: settings, MCP server, `/memory` skill, `lcm.md`, doctor, as before.
  Run from the plugin bundle it leaves the MCP entry in `settings.json` alone
  (`plugin.json` registers the server) and clears only plugin-cache versions
  older than its own: a newer plugin beside an older npm CLI is a supported state.
- Codex: when `codex` is on PATH, the equivalent of `lcm connectors install codex
  --global`; project scope stays explicit through `lcm connectors`. Run from the
  plugin bundle it skips Codex and names the npm CLI: the hooks would otherwise
  carry a versioned plugin-cache path the next plugin update deletes.
- `--dry-run` performs no writes, the shared core included: every write, copy and
  removal goes through the injected service deps.
- One outcome per harness; the CLI exits non-zero when any harness failed.
  Reinstalling reconciles idempotently.

## Release order

`main` requires the `ci` check, so no workflow commits to it directly.
`version-pr.yml` runs `npm run version-packages`, which bumps the version and then
builds `dist/` and `bundle/`; the changesets action commits everything into the
version PR. CI runs on that commit; merging it triggers `publish.yml`, which tags
the merge commit as before. `publish.yml` neither builds nor touches `bundle/`.

## Rejected

- **Thin adapters over an npm-global core with a locator.** A marketplace install
  stays silent until `lcm install` runs; adapter and core drift without a version
  handshake; a locator written in JavaScript still needs `node` to find `node`;
  renaming the plugin breaks every existing install.
- **Committed `node_modules`.** Repository size and platform portability.
- **`npm ci` in the first hook.** Network and a 60 s timeout on a lifecycle
  deadline: the failure that motivated this change.
- **Platform binaries.** A release matrix the current Node runtime does not need.
