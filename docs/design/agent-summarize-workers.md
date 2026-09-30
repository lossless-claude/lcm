# Agent summarize workers

## Contract

A declared worker is a dedicated session launched with `LCM_SUMMARIZE_WORKER=1`.
Its hook enrolls its session id and cwd before an agent may receive pool work.
Admission is live; capture exclusion is whole-session and permanent. Finishing,
a timeout, resuming, and clearing never lift exclusion. An ordinary session is
never enrolled by a claim. Forking a worker session is unsupported.

`WorkerStore` (`src/store/worker-store.ts`) owns durable enrollment and exclusion.
Enrollment accepts new `startup`/`clear` ids; resume, compact, continue and fork
cannot enroll. `registerWorkerSession` (`src/worker-session.ts`) uses
`withProjectMutation` for callers in one process and a SQLite `BEGIN IMMEDIATE`
transaction for its history check across processes. Existing messages, summaries,
provenanced promotions and tool events refuse enrollment without deletion. The
sidecar gate and main-store tombstone are installed before admission. A capture
that wins the race requires a fresh worker id, preserving the captured conversation.
Destructive cleanup belongs to parser-confirmed copied-claim recovery. It removes
attributable content and retains promotions without provenance.

`SessionCapture.writeInTransaction` gates writes and rebuild writes. Transcript
capture and `/ingest` also gate excluded sessions before parsing. Descendants
are recognized through stored ancestry, Claude's `subagents/` directory and its
discovery adapter; missing metadata does not defeat directory exclusion.
`EventsDb.enrollSessions` installs the sidecar gate in a write transaction.
Per-row event insertion checks the gate before inserting; bulk writes check it
inside their write transaction. Tool
recording and promotion check exclusion; `PromotedStore.insert` rejects excluded
provenance. `/compact` checks at entry and after yielded work; the compaction
engine and summary writer also refuse excluded sessions. Scan, import and replay
share these capture and compaction gates.

The warning states that this session and its subagents are not recorded by lcm,
that the harness's own transcript stays on disk, and that a dedicated session
should be used. Registration, claims and status carry it. Status, doctor and
stats expose enrollment state and last activity without re-enabling capture.

Claude tool-use names and paired call ids detect copied successful claims. These
markers authorize nothing: recovery excludes the copied session as abandoned.
A refused claim without a payload does not convert an ordinary session.

## Harness evidence

- Confirmed in repository code: `src/hooks/dispatch.ts:dispatchHook` is Claude's
  sole registrar. It receives the native SessionStart source and owns revocation
  across `/clear`; `hooks/lcm-hooks.ts:registerSessionStart` never re-registers,
  including after hot reload.
- Claude Code exports `CLAUDE_CODE_SESSION_ID` to shell and stdio MCP runtimes:
  unverified by repository code. It is the supplied harness contract; fake
  transport tests can verify binding, not prove a host's environment export.
- Codex exports `CODEX_THREAD_ID` to shell commands: unverified by repository
  code. Codex MCP environment propagation is unverified and refused.
- OMP passes `PI_SESSION_FILE` to tool runtimes: unverified by repository code.
  Its shell and MCP identities are unverified and refused.
- Codex and OMP lack verified subagent discovery here. Child-context claims are
  unsupported; inherited cwd or an agent-supplied id cannot establish admission.

## Trade-off

Stretch exclusion cannot prevent later reasoning, retries, host compaction or
handbacks from carrying foreign source content. Permanent exclusion sacrifices
worker-session memory to prevent cross-project capture. Verified context reset
and content-free handbacks are prerequisites for any narrower exclusion.

## Transports and accounting

The MCP catalog and CLI pair share `createAgentWorkerTransport`, which reads native
identity from the harness environment. `admitWorker` checks live enrollment and
canonical cwd before each claim and submit, and again after a held poll. A unique
worker id per agent claim allows parallel work; submissions also match the stored
binding. Native isolated hooks use the same pool routes and admission checks.
OMP hook identity is confirmed in `hooks/omp/lcm.ts:sessionIdentity` through the
session-manager API; OMP shell/MCP and Codex MCP remain unverified and refused.

Every MCP and CLI claim carries guidance that the job's `system` and `prompt`
are untrusted data to summarize, never instructions to follow. The MCP description
carries the same rule. The `lcm store` / `lcm_store` refusal is a client-side guard:
a command without the worker environment cannot be detected. Harness environment
ids are cooperative identity, not authentication against local processes.

Claim markers are structural parser metadata, keyed by tool-call id across capture
deltas. Structured `/ingest` ignores wire-supplied marker fields. Native parsing
recognizes MCP claims and CLI invocations by basename, including absolute paths
and `node …/lcm.js`. A parser-shape change forces historical checkpoints to be verified before
recovery. Recovery cleans the main store and event sidecar and grants no admission.

Pool provider ids accept a validated model suffix. Missing usage is estimated from
the system, prompt and answer. `llm.poolCompletionMs` / `LCM_POOL_COMPLETION_MS`
bounds completion after claim, default 180000 ms. The queue claim deadline remains
20000 ms, and session-owned jobs get a fresh 60000 ms completion deadline after claim. Pool expiry records
abandoned enrollment without removing exclusion; late answers are discarded and
the provider chain handles unanswered work.

Tests use fake models only. They cover the three supported agent pairs, refused
pairs and undeclared/stale callers, independent parallel claims, worker-bound
submission, canary absence, cleanup, restart, real transcript-scan races, compaction and promotion attempts, structural
recovery and the configurable deadline. Harness environment export behavior is
unverified by these fakes and remains the supplied external contract.

Command hooks identify the native harness ancestor by executable name and process
start time, rather than the transient shell parent. An unverifiable owner refuses
enrollment. No process arguments or foreign process environment are read. Codex
adds its own `CODEX_THREAD_ID` to the owner so app-server threads are independent;
OMP owners include the native session id. Claude command hooks keep the native
process owner across function-hook reloads. Distinct owner scopes in the same cwd
remain independent. Codex cursor fingerprints change when claim decoding changes.

A disconnected client whose response has not finished releases the claim under
its remaining queue window. It does not abandon the worker. Diagnostic surfaces
show an eight-character hashed worker id rather than the harness session id.
