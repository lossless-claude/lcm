# CI on the Mac mini

The `ci` job targets the repository-scoped runner `mac-mini-m4-lcm`, with labels
`self-hosted`, `macOS`, `ARM64`, and `lcm`. Its launchd service and working
directory are separate from dwigt's runner on the same host. Node 22 is provisioned by
`actions/setup-node`; ripgrep must be available on the service's saved PATH
(Homebrew installs it in `/opt/homebrew/bin`).

The job retains the `ci` check name and runs dependency installation, typecheck,
build, tests, and workspace-artifact checks. Superseded runs for the same ref are
cancelled, and each run has a 30-minute timeout.

## Validate plugin manifest

The step runs `claude plugin validate` twice, because the two invocations
validate different things:

```sh
claude plugin validate --strict .
claude plugin validate .claude-plugin/plugin.json
```

The repo root holds both `marketplace.json` and `plugin.json`, and the
marketplace manifest wins there — so the first call checks only that manifest,
strictly: unrecognized fields, missing metadata, and other issues the runtime
tolerates. The plugin's own agents, skills, commands and hooks module are walked
only when `plugin.json` is named, which is what the second call does.

That second call is deliberately **not** `--strict`. Under `--strict` it fails
on one structural warning — that root `CLAUDE.md` is not loaded as plugin
context — which is true and not worth acting on: this repository is both a
project and a plugin, and `CLAUDE.md` is its project-instruction file. Errors
still fail the step without `--strict`, and errors are what matter here: this
walk is what found four `agents/*.md` files whose YAML frontmatter had never
parsed, so each of those agents had been loading with every field but the
filename-derived name silently dropped.

Both calls need the `claude` CLI, which a fork PR's GitHub-hosted Linux box does
not have. The step therefore checks `command -v claude` first and, when absent,
prints a `::warning::` annotation and exits `0` rather than failing red — loud,
not silent. On the self-hosted Mac mini the binary is on the saved runner PATH
(`~/actions-runner-lcm/.path` includes `~/.local/bin`); if that file is ever
regenerated, re-add that entry or the step goes quiet on every run.

What this step does **not** do: it does not know whether a given
`$.noun.method(...)` call still exists on any particular Claude Code build. See
`docs/hook-protocol.md` for what it validates instead, and why it does not
replace `npm run typecheck:hooks`.

## Isolation

Fork pull requests run on GitHub-hosted Linux. Same-repository branches execute
on the persistent Mac mini and must be trusted. The service uses the
host's existing runner account; a temporary HOME is filesystem hygiene, not a
security sandbox or a separate operating-system identity.

Checkout cleans the job workspace and does not persist its GitHub token. Build
and tests use HOME and temporary directories under `runner.temp`, and plugin
cache synchronization is disabled. This keeps test databases, Codex/Claude
fixtures, npm data, and build hooks away from the interactive LCM installation.

## Operations

The LCM instance lives in `~/actions-runner-lcm`. Use its own `svc.sh` to inspect
or restart it; do not reconfigure or stop dwigt's instance. Runner credentials
stay outside this repository. A fresh registration requires a short-lived token
from this repository and the additional `lcm` label. Verify the service's `.path`
contains `/opt/homebrew/bin` (ripgrep) and `~/.local/bin` (the `claude` CLI, for
the plugin-manifest step) before starting it.

```sh
gh api repos/lossless-claude/lcm/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

If the host is unavailable, manually run the same job on GitHub-hosted Linux:

```sh
gh workflow run ci.yml --ref <branch> -f hosted=true
```

The runner choice changes within the same job, so the required `ci` check cannot
pass merely because a separate self-hosted job was skipped. The dispatch entry
becomes available after this workflow reaches the default branch.
