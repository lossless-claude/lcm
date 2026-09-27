# Hook operation outcomes and pre-compaction capture

## Contract

A Hook invocation can attempt several Hook operations. Report each operation's outcome independently: `completed`, `skipped`, `delegated`, `deferred`, `failed`, or `unknown`. Keep delivery observations (`submitted`, `accepted`, `unconfirmed`, `rejected`) separate from the operation's execution outcome. A client timeout leaves execution unconfirmed until authoritative evidence establishes a later result. No retained observation means coverage is unknown; it does not prove that the harness omitted the invocation.

Every active Claude Code command hook, Claude Code function hook, Codex hook, and OMP hook with a usable Session identity contributes to bounded per-Session evidence. Keep counts and first/last observation by harness, hook, operation, outcome, and reason. Retain exceptional failures individually. Do not retain prompt text, tool payloads, or summary text as diagnostic evidence. An invocation is not a success or failure merely because one of its operations is. A malformed hook payload without Session identity stays fail-open and has unknown coverage; it must not create a diagnostic file merely to record malformed input. The documented `LCM_ENABLED=false` opt-out keeps Claude Code and Codex command hooks as no-ops; a diagnostic reader cannot infer which environment an earlier invocation inherited.

Hook observation preserves host deadlines and fail-open behavior. Local diagnostic writes consume a measured, bounded part of the host deadline. Evidence should remain inspectable when the daemon is unavailable where a host's local storage permits it; this requires a persistence and inspection experiment before choosing the sink. Abrupt termination or storage failure can leave incomplete coverage; diagnostics must say so rather than imply a complete invocation history.

For a pre-compaction invocation, lcm attempts Capture before its own summarization. A successful Capture attempt with zero new messages still permits summarization of stored history. A failed or deferred Capture skips only this invocation's lcm summary; native harness compaction continues. A client timeout does not establish Capture failure: the daemon may later finish and record the outcome. Summarizer disablement or an already-running summary cannot silently suppress the Capture attempt. Busy admission is decided when the invocation arrives: it skips this invocation's summary but still permits Capture, even if the prior summary finishes before Capture begins. A later summary failure does not erase evidence that Capture succeeded.

`/session-end` returning `202` establishes acceptance by the running daemon, not durable completion or recovery after daemon restart. Its later Capture and follow-up outcomes remain separate.

## Seams

### Hook observation module

The interface accepts an observation with its reporter and operation identity, then reads a bounded summary for one Session:

```ts
interface HookObservations {
  record(observation: OperationObservation, deadlineAtMs: number): Promise<RecordResult>;
  inspect(session: SessionRef): Promise<HookSummary>;
}
```

The implementation owns aggregation, bounded retention, exceptional records, redaction, concurrent-writer safety, and coverage wording. Reason codes are bounded; inspection reports retention truncation. For a daemon-owned operation, the adapter reports delivery and the daemon alone reports the terminal execution outcome. For a locally executed operation, its local adapter reports the terminal outcome. Operations observed on both sides carry a stable identity across transport retries. Terminal identities remain deduplicated for a finite window; evidence arriving after that window cannot silently increment a terminal count or claim exact reconciliation. The implementation may retain bounded pending identities without storing one durable row per ordinary completed invocation.

Host adapters translate native callback names and local transport results into the shared vocabulary. The hot tool path adds no second daemon request: a local tool event write may record its observation in the same local work, and a remote tool event request carries the evidence it already creates. A no-match or early-return path with Session identity has no such write to reuse and needs a separate bounded local observation. Measure that work before fixing the storage strategy.

The evidence seam has local and daemon-backed adapters. Short-lived Claude Code command and Codex lifecycle hooks use a bounded local append log so they do not load experimental SQLite at startup. Tool capture and daemon-owned pre-compaction outcomes aggregate in the project's sidecar. Claude Code function hooks use alternating whole-file snapshots through the host's `$` facilities; OMP uses alternating local snapshots through its standalone Bun/Node implementation. The command append log respects the existing maintenance admission fence. Local persistence and flush semantics determine the loss window; missing evidence never proves a callback did not run. The daemon log records completed responses and operation-specific events, not every request arrival.

### Pre-compaction module

The daemon owns the dependency between Capture and summarization behind one interface:

```ts
interface Precompaction {
  run(input: PrecompactInput): Promise<{
    capture: CaptureOutcome;
    summary: SummaryOutcome;
  }>;
}
```

The ordinary compaction path owns one slot in the existing per-project queue and captures before summarizing. When a summary for the same session already occupies that queue, a required pre-compaction Capture uses a separate database connection so it can finish before the host deadline; the new summary is skipped. Capture is attempted independently of provider availability. Summarization starts only after Capture is established as successful and summary admission permits it. A disabled summarizer produces a summary outcome without suppressing Capture. Claude Code command and Codex use this daemon-owned sequence. OMP's short host budget keeps a bounded awaited Capture followed by an unawaited summary request; it submits the summary only after `/ingest` confirms Capture. Native callback output remains fail-open.

The existing `/compact` route cannot satisfy this interface by merely omitting `skip_ingest`: it checks busy and disabled cases before Capture, and a missing transcript can fall through to summarization of stored history. Those cases must be preserved or changed deliberately as the route delegates to the new module. Other `/compact` callers retain their current behavior unless migrated explicitly.

## Dependency strategy

- In-process outcome classification and Capture-before-summary policy are tested through the module interfaces.
- Capture, summary stores, SQLite, and local files are local-substitutable dependencies tested with temporary storage.
- Daemon HTTP is a remote-owned seam with production transport and in-memory test adapters. Harness callback interfaces are external; each harness adapter translates to and from the lcm contract.
- The Claude Code function module cannot import Node or SQLite. The OMP hook is standalone and must not depend on repository-only modules at runtime. Contract fixtures keep their wire shapes aligned with the daemon.

## Implementation order and verification

1. Define execution outcomes, delivery observations, reporter authority, retry identity, expiry behavior, and the command-hook opt-out. Prove bounded offline recording and inspection for one short-lived command hook and the constrained function-hook path; measure the added work before fixing flush and retention limits.
2. Deepen pre-compaction in the daemon with one queue owner for Claude Code command PreCompact and Codex. Verify Capture success with zero new messages, failure, timeout, summarizer disabled, and summarizer busy. For OMP, preserve the bounded awaited `/ingest` and skip its unawaited lcm summary when Capture is unconfirmed. Native compaction proceeds in every harness; the function module does not replace command PreCompact.
3. Add bounded cross-harness aggregation and local evidence for the remaining active hook paths. Keep the local tool hook fast path, and account for no-match and early-return paths. Make evidence readable through the smallest existing diagnostic surface that fits, with retention and coverage limits visible.

Published hook behavior changes require the hook protocol documentation and a changeset in the same PR. The usual documentation, agent-contract, typecheck, test, and plugin-validation gates apply to the files they cover.
