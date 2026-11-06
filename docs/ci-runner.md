# CI

The `ci` job runs on GitHub-hosted `ubuntu-latest` for every event. Node 22 is
provisioned by `actions/setup-node`; the job installs ripgrep with `apt-get` and a
pinned `claude` CLI with `npm`.

The job retains the `ci` check name and runs dependency installation, typecheck,
build, tests, and workspace-artifact checks. Superseded runs for the same ref are
cancelled, and each run has a 30-minute timeout.

CI machines are shared, so CI time is not idle time. Each unit test gets 20 s
(`testTimeout` in `vitest.config.ts`) instead of vitest's 5 s default. Setup-heavy tests
that take 1–3 s on an idle machine otherwise time out under load, which fails the run
without a defect in the code.

## Validate plugin manifest

The step runs `claude plugin validate` twice, because the two invocations
validate different things:

```sh
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin validate .claude-plugin/plugin.json
```

The first call checks only the marketplace manifest, strictly: unrecognized fields,
missing metadata, and other issues the runtime tolerates. The plugin's own agents,
skills, commands and hooks module are walked when `plugin.json` is named, which is what
the second call does. Both are named because `--strict .` walks the plugin as well as
the marketplace, and so fails on the warning below.

That second call is deliberately **not** `--strict`. Under `--strict` it fails
on one structural warning — that root `CLAUDE.md` is not loaded as plugin
context — which is true and not worth acting on: this repository is both a
project and a plugin, and `CLAUDE.md` is its project-instruction file.

The CLI version is pinned in `.github/workflows/ci.yml`, because a new version can add
checks and turn the required `ci` check red with no change in this repository. Raise
the pin in its own pull request.

What this step does **not** do: it does not know whether a given
`$.noun.method(...)` call still exists on any particular Claude Code build. See
`docs/hook-protocol.md` for what it validates instead, and why it does not
replace `npm run typecheck:hooks`.

## Isolation

Every run gets a fresh GitHub-hosted machine, so fork and same-repository pull requests
run the same way and nothing carries over between runs.

Checkout does not persist its GitHub token. Build and tests use HOME and temporary
directories under `runner.temp`, and plugin cache synchronization is disabled.

A temporary HOME does not isolate the loopback: a test process that resolves the
daemon's default port can probe it, SIGTERM it or spawn over it. The test harness closes
that on every machine: `test/setup-env.ts` gives each test file its own HOME and an lcm
home whose `config.json` names another port, and `test/setup-port-guard.mjs`
refuses the default port (`LCM_TEST_GUARDED_PORTS`) in every Node process the
suite runs, logging each refusal under `LCM_TEST_GUARD_DIR` and failing the test
file that made it. `test/port-guard.test.ts` holds both in place.
