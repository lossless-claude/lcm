# Agent summarize workers

## Contract

A declared worker is a dedicated session launched with `LCM_SUMMARIZE_WORKER=1`.
Its hook enrolls its session id and cwd before an agent may receive pool work.
Admission is live; capture exclusion is whole-session and permanent. Finishing,
a timeout, resuming, and clearing never lift exclusion. An ordinary session is
never enrolled by a claim. Forking a worker session is unsupported.

`WorkerStore` (`src/store/worker-store.ts`) owns durable enrollment and exclusion.
`registerWorkerSession` (`src/worker-session.ts`) holds `withProjectMutation`,
excludes the sidecar first, removes provenanced content from the project store,
and leaves `session_ingest_log` as a tombstone. A failed cleanup cannot authorize
release. Promotions with neither a session nor a summary provenance are counted
and reported; their content cannot safely be attributed and is retained.

`SessionCapture.writeInTransaction` gates writes and rebuild writes. Transcript
capture and `/ingest` also gate excluded sessions before parsing. Descendants
are recognized through stored ancestry, Claude's `subagents/` directory and its
discovery adapter; missing metadata does not defeat directory exclusion.
`EventsDb` checks a durable sidecar exclusion in its write transaction. Tool
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

- Confirmed in repository code: `hooks/lcm-hooks.ts:registerSessionStart` handles
  `session.start`, and `docs/hook-protocol.md` specifies another start after
  `/clear`. A loaded hook's owner registers the new id and revokes the old id.
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
