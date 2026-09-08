# CI on the Mac mini

The `ci` job targets the repository-scoped runner `mac-mini-m4-lcm`, with labels
`self-hosted`, `macOS`, `ARM64`, and `lcm`. Registration and service activation
are pending; provision the runner before merging, or jobs will remain queued.
Its service and working directory must be separate from dwigt's runner on the
same host. Node 22 is provisioned by
`actions/setup-node`; ripgrep must be available on the service's saved PATH
(Homebrew installs it in `/opt/homebrew/bin`).

The job retains the `ci` check name and runs dependency installation, typecheck,
build, tests, and workspace-artifact checks. Superseded runs for the same ref are
cancelled, and each run has a 30-minute timeout.

## Isolation

Fork pull requests run on GitHub-hosted Linux. Same-repository branches execute
on the persistent Mac mini and must be trusted. The proposed service uses the
host's existing runner account; a temporary HOME is filesystem hygiene, not a
security sandbox or a separate operating-system identity.

Checkout cleans the job workspace and does not persist its GitHub token. Build
and tests use HOME and temporary directories under `runner.temp`, and plugin
cache synchronization is disabled. This keeps test databases, Codex/Claude
fixtures, npm data, and build hooks away from the interactive LCM installation.

## Operations

Install the LCM instance in `~/actions-runner-lcm`. Use its own `svc.sh` to inspect
or restart it; do not reconfigure or stop dwigt's instance. Runner credentials
stay outside this repository. A fresh registration requires a short-lived token
from this repository and the additional `lcm` label. Verify the service's `.path`
contains `/opt/homebrew/bin` before starting it.

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
