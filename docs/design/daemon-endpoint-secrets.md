# The daemon resolves endpoint keys from a source it owns

**Status:** proposed, 2026-09-27. Scopes #591.

An HTTP endpoint's `apiKey` or `baseURL` may name an environment variable as `${NAME}`.
The daemon expands it once, from its own process environment, when it loads its config.
That environment is copied from whichever client found the daemon down and spawned it:
a hook, the MCP server, a CLI command. A spawner started without a key yields a daemon
whose chain leaves that endpoint out (`summarizer.endpoint_unavailable`), or has no
summarizer at all, until something restarts it from an environment that has the key.
Whether summaries work depends on which client started the daemon last.

Keeping a key as a shell expression that reads the OS keychain, as the issue describes,
makes this the common case: only a shell that evaluated the expression has the variable,
and most spawners are not such a shell.

## Invariants any fix keeps

1. A secret value is never logged, never returned by a route (`/health` included), and never
   written by lcm to `config.json`, the database or any other file.
2. `${NAME}` in `apiKey` / `baseURL` stays valid and keeps its meaning where nothing else is
   configured.
3. An unresolvable key disables only the endpoint that needs it; capture, search and the
   rest of the chain keep running.
4. Works on macOS and Linux.
5. No new always-on process.

## Today's path

The environment freezes in the child at spawn and is read exactly once:

1. `src/daemon/lifecycle.ts:ensureDaemon` spawns `<node> <entry> daemon start --automatic`
   detached, with `env: { ...process.env }`: the caller's whole environment, nothing added.
2. `src/cli/daemon.ts` (`daemon start` action) calls `loadDaemonConfig(configPath)`, whose
   `env` defaults to `process.env`.
3. `src/daemon/config.ts:loadDaemonConfig` → `src/daemon/provider-config.ts:normalizeNamedEndpoints`
   → `normalizeEndpoint` → `normalizeHttpEndpoint` → `expandEnv`. An unset name is recorded in
   the endpoint's `missingEnv`; `defaultApiKey` does the same for an `anthropic` endpoint
   without a key and without `ANTHROPIC_API_KEY`. The resolved value is stored in
   `config.llm.providers.<name>.apiKey`.
4. The flat form is the same class of problem with a worse failure: `loadDaemonConfig`
   replaces an unset `${NAME}` in `llm.apiKey` with `""` and records nothing, so an `openai`
   provider sends a placeholder key (`src/llm/openai.ts`) and fails at request time.
5. `createDaemon(config)` (`src/daemon/server.ts`) holds that object for the process's life;
   nothing reloads it.

Consumers of the frozen result:

- `src/daemon/summarizer.ts:namedChain` drops every endpoint with `missingEnv`;
  `chainOf` / `createSummarizer` build the chain from it, and `firstRunnableSummarizer` /
  `configuredSummaryModel` (the model the replay ledger records) skip the same endpoints.
- `src/daemon/summarizer.ts:logUnavailableEndpoints` writes one `summarizer.endpoint_unavailable`
  per such endpoint at startup (`src/cli/daemon.ts`).
- `GET /health` (`src/daemon/server.ts`) returns `summarizerAvailability(config.llm)`.
- `src/doctor/doctor.ts:addNamedEndpointChecks` reports the running daemon's view when one
  answers ("the running daemon's environment"), else this shell's (`localAvailability`), and
  fails with "export … in the environment that starts the daemon, then: lcm daemon restart".

### Every spawner

All of them go through `ensureDaemon`, so each passes its own process environment.

| Spawner | Where | Spawns? | Environment it passes |
|---|---|---|---|
| Claude Code command hooks, first hook of a session | `src/hooks/dispatch.ts` → `src/bootstrap.ts:ensureCore` | yes (not for `post-tool`, `compact`) | the harness's hook process |
| SessionStart, UserPromptSubmit, PreCompact | `src/hooks/restore.ts:handleSessionStart`, `src/hooks/user-prompt.ts:handleUserPromptSubmit`, `src/hooks/compact.ts:handlePreCompact` | yes, 5 s budget | the harness's hook process |
| SessionEnd | `src/hooks/session-end.ts:handleSessionEnd` | never (`noSpawn`) | — |
| Codex lifecycle hooks | `src/hooks/codex.ts:defaultDeps` (`connect`) | yes, except short-deadline events (`noSpawn`) | Codex's hook process; whether Codex passes its full environment to hooks is **unconfirmed** |
| Claude Code function-hooks module | `hooks/lcm-hooks.ts:startDaemon` → `sh -c 'lcm daemon start --detach --automatic'` → the CLI's `ensureDaemon` | yes, two hops | whatever the host's `$.process.run` gives a child; assumed to be the host's environment, **unconfirmed** |
| MCP server, at start and on a dropped connection | `src/mcp/server.ts:startMcpServer`, `handleDaemonRequest` | yes, 10 s | what the MCP host gives the server; some hosts filter it, **unconfirmed** per host |
| Any CLI command that needs the daemon | `bin/lcm.ts:createDaemonClientOrExit` | yes | the invoking shell, or an agent's tool shell |
| `lcm daemon start --detach`, `lcm daemon restart` | `src/cli/daemon.ts` | yes | the invoking shell |
| `lcm doctor` (auto-start when down, replace when stale) | `src/doctor/doctor.ts:runDoctor` | yes | the shell, or the MCP server when run as `lcm_doctor` |
| OMP extension | `hooks/omp/lcm.ts` | no spawn path | — |

Two things make a respawn routine rather than rare: the daemon exits after
`daemon.idleTimeoutMs` (30 minutes by default), and a newer caller replaces an older daemon
(`daemonOwnership` → `restart`). Each respawn re-rolls which environment the chain gets.

## Options

| # | Option | Verdict |
|---|---|---|
| A | Daemon-owned key file (`0600`, e.g. under the lcm home) that `${NAME}` falls back to | Works, but plaintext at rest; the users this issue is about chose the keychain to avoid that. Subsumed by C. |
| B | Native keychain reference in config (`${keychain:<service>}`) | lcm would own per-OS code for each store; Linux has no single store. Subsumed by C. |
| **C** | **A per-name credential command in config, run by the daemon when it builds the endpoint** | **Recommended.** |
| D | A spawner lacking a key refuses to spawn, or hands off | Breaks invariant 3; nobody to hand off to without breaking invariant 5. |
| E | The client pushes its keys to the daemon on first contact | Still environment-dependent; lost at every idle exit; a new secret-bearing route. |
| F | Restart-with-env when the daemon lacks a key the client has | Kills in-flight work; clients with different keys restart each other. |
| G | Spawn through the user's login shell (`$SHELL -lc …`) | Widens the dependency instead of removing it; runs shell startup files from hooks. |

### A. Key file

- **Security:** plaintext on disk, `0600`. Not a new class: `config.json` is created `0600`
  (`src/bootstrap.ts:ensureCore`) and already accepts a literal key; `daemon.token` follows
  the same pattern (`src/daemon/auth.ts`). It is still a second copy of a secret the user
  keeps in a keychain.
- **Failure modes:** a missing or unreadable file leaves the endpoint out, as today.
- **UX:** the user copies each key into another file and keeps it in sync on rotation.
- **Code:** small (a parser and a lookup in `expandEnv`).
- **Doctor / `/health`:** doctor can check the file mode; `/health` unchanged.

### B. Native keychain reference

- **Security:** no copy at rest.
- **Failure modes:** macOS `security` run from a detached daemon with no terminal may hit an
  access prompt it cannot show, or a locked keychain in a session without a GUI login;
  Linux `secret-tool` needs a D-Bus session bus and an unlocked keyring, which headless hosts
  lack, and `DBUS_SESSION_BUS_ADDRESS` is itself inherited from the spawner. All **unconfirmed**:
  nothing in the repository exercises them.
- **UX:** one field per key; unusable for `pass`, 1Password's CLI or any other store lcm does not name.
- **Code:** medium, one adapter per store, plus the tests for each.
- **Doctor / `/health`:** as C.

### C. Credential command (recommended)

`config.json` declares, per variable name, a command whose standard output is the value:

```json
{
  "llm": {
    "secrets": {
      "OPENROUTER_API_KEY": { "command": ["/usr/bin/security", "find-generic-password", "-s", "<service>", "-w"] }
    },
    "providers": {
      "openrouter": { "type": "openai", "model": "<model>", "baseURL": "https://openrouter.ai/api/v1", "apiKey": "${OPENROUTER_API_KEY}" }
    }
  }
}
```

On Linux the same slot holds `["/usr/bin/secret-tool", "lookup", "service", "<service>"]`,
`["/usr/bin/pass", "show", "<entry>"]`, or `["/bin/cat", "<path to a 0600 file>"]` — which is
option A without lcm owning a file format. This is the credential-helper pattern of git's
`credential.helper` and the AWS CLI's `credential_process`.

Rules:

- A name declared in `llm.secrets` resolves only from its command, never from the environment,
  so the daemon's key no longer depends on its spawner. An undeclared name resolves from the
  environment exactly as today (invariant 2).
- `${NAME}` references to a declared name are allowed in `apiKey` only. A `baseURL` is not a
  secret, and keeping it environment-only keeps its URL check at load. A declared
  `ANTHROPIC_API_KEY` also feeds the implicit key of an `anthropic` endpoint that sets none
  (`defaultApiKey`), so the two ways of naming that key cannot disagree.
- Load validates the shape only: a `\w+` name, a non-empty array of strings, an absolute
  `argv[0]` (the daemon's `PATH` is also inherited from the spawner). Load runs nothing:
  hooks, the MCP server and CLI commands call `loadDaemonConfig` just to read the port.
- The daemon runs the command when it first builds that endpoint's adapter: `execFile` with
  no shell, stdin closed, a timeout, an output cap, one trailing newline trimmed. Standard
  error is discarded. An empty output, a non-zero exit or a timeout is a failure.
- The value lives only inside the adapter's client object; it is never written back into
  `config.llm`, so no route or log that serializes the config can carry it.
- A failure is logged as the name and the outcome (`exit <n>`, `timeout`, `empty`), never
  the output, and raised as an error the chain treats as advancing
  (`src/llm/provider-chain.ts:failureAdvancesChain`), then retried at the next build.

Assessment:

- **Security:** no copy at rest beyond the user's own store. Running a command from
  `config.json` means whoever can write that file can run code as the user; they can already
  point a `baseURL` at their own server and receive the key and every summarized transcript,
  so no trust boundary moves. The command's own access to its store is subject to B's
  **unconfirmed** caveats; C does not remove them, it lets the user pick a store that works
  non-interactively on their host.
- **Failure modes:** a locked store or a failing command disables only that endpoint, per
  summary attempt, and recovers without a restart once the command succeeds. Rotation needs a
  daemon restart (the value is cached per process), as today.
- **UX:** the user moves the expression their shell profile already runs into config, once.
- **Code:** a schema check in `provider-config.ts`, a resolver used from
  `summarizer.ts:createEndpointSummarizer`, one error type, tests. Estimated at a few hundred
  lines with tests, **unmeasured**.
- **`/health`:** `summarizer` gains, per endpoint with a declared key, whether it has resolved,
  not yet been tried, or last failed and how. Never the value.
- **Doctor:** checks that each declared `argv[0]` is absolute and executable, reports the
  daemon's resolution state from `/health`, and changes its fix text to name `llm.secrets`
  next to exporting the variable. It does not run the command: `lcm_doctor` runs from an
  agent, and a store may raise a prompt.

What a call-time key changes in today's code, which the implementation must handle:

- `createSummarizer` awaits the first link's adapter eagerly, and the compact handler
  (`src/daemon/routes/compact.ts:createCompactHandler`) caches that promise per provider with
  no eviction. A resolution failure there would be a permanently cached rejection. Loading
  the client library stays eager; resolving the key moves inside the link, where the chain
  catches it.
- `namedChain` and `firstRunnableSummarizer` treat an endpoint with a declared key as
  runnable, since they cannot know before it runs. The replay ledger's configured model may
  then name an endpoint that fails resolution; the chain's `summarizer.fallback` event records
  what ran instead.

### D. Refuse to spawn, or hand off

A client that lacks a key the config names does not start the daemon. Capture, search and
restore stop with it, for a summarizer key: that trades an optional feature for the core one
(invariant 3). Handing off needs a process that has the key and is waiting to be asked; the
hooks' shell is usually the only spawner there is, so the only candidate is a resident helper
(invariant 5). Small code; the doctor and `/health` would report a daemon that is down.

### E. Push keys on first contact

The client already can see the gap: `/health` lists each left-out endpoint's `missingEnv`, and
the client can intersect it with its own environment and `POST` the values to a new route.

- **Security:** the value crosses loopback HTTP to a bearer-token route. Any holder of
  `daemon.token` could set a key; allowing it for `baseURL` would let them redirect summaries,
  so it must be limited to `apiKey`. `route.failed` logs the error, not the body
  (`src/daemon/server.ts`), but every new route that carries a secret is one more place to keep
  out of logs.
- **Failure modes:** the key is held in memory only, so each idle exit loses it until a client
  that has it comes back. A daemon started and used only by clients without the key never gets it.
- **UX:** invisible when it works; non-deterministic when it does not.
- **Code:** a route and client logic in every spawner above (hooks, Codex, function hooks, MCP, CLI).
- **Doctor / `/health`:** as today, plus which endpoints were supplied by a client.

### F. Restart with the client's environment

A client that has a key the running daemon lacks replaces the daemon, as `ensureDaemon` does
for an older version.

- **Failure modes:** kills compactions in flight; two clients holding different keys would
  replace the daemon at each other, the same loop `src/bootstrap.ts:ensureCore` avoids by not
  comparing build ids; hook budgets are 5 s.
- **Code:** small (a comparison in `ensureDaemon`).
- **Doctor / `/health`:** unchanged; the problem stays environment-dependent.

### G. Spawn through a login shell

`ensureDaemon` spawns `$SHELL -lc 'exec … daemon start --automatic'`, so the user's profile
evaluates the keychain expression.

- **Failure modes:** which startup files a login, non-interactive shell reads differs between
  shells; a profile that prints, prompts, or is slow breaks or stalls a hook with a 5 s budget;
  fish and other non-POSIX shells need their own quoting. The key still comes from an
  environment, now one assembled by the profile.
- **Security:** no change.
- **Code:** small.
- **Doctor / `/health`:** unchanged.

## Recommendation

C. Only a source the daemon owns removes the dependency on the spawner's environment, which
is what the issue asks for; E, F and G move it, D gives up capture to avoid it. Of the
daemon-owned sources, a command covers A and B without lcm owning a file format or a
per-OS keychain adapter, and keeps `${NAME}` unchanged for everyone who does not declare a
source.

Not covered by this note: the flat `llm.apiKey` form (its silent `""` substitution is its own
defect), and the other variables the daemon reads from its environment at start
(`LCM_SUMMARY_PROVIDER` and the tuning variables in `docs/configuration.md`), which have the
same spawner dependency but carry no secret.

## First PR

The resolver and its wiring, no reporting changes:

1. `provider-config.ts`: parse and validate `llm.secrets` (shape, absolute `argv[0]`, `apiKey`
   references only). An endpoint whose only unset names are declared is not marked
   `missingEnv`; it records which declared names its `apiKey` needs.
2. A resolver module: runs one declared command under the rules above, caches the value per
   process, returns a typed failure.
3. `summarizer.ts`: the adapter build resolves the key inside the link; the eager first-link
   build loads only the client library; the failure type advances the chain and is retried at
   the next build.
4. Tests: a declared name ignores the environment; an undeclared name behaves as today; a
   failing, empty or slow command leaves only that endpoint out and does not poison the
   compact handler's cache; the value never appears in `config.llm`, `/health` or the log.
5. `docs/configuration.md` (the named-endpoint table and "Unset variables") and
   `docs/architecture.md` ("Authentication") describe `llm.secrets`; a changeset.

A second PR adds the `/health` resolution state and the doctor checks. It is also where the
**unconfirmed** keychain behaviour of a detached daemon on macOS and Linux gets checked on
real hosts before the docs recommend a specific command.
