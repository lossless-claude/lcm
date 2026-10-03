# Compaction header jobs

Header generation is separate from leaf and condensed summaries, which stay on
the configured pipeline, including `pool`. Preparing a header never regenerates
the DAG. The executor is a library interface with no registered compaction hook;
native remains the baseline. Dispatch and daemon job transport are integration work.

## Document and excerpts

The order is verbatim user excerpts, working-state header, window, engine tail.
The captured window and originals remain complete and immutable. Structured
window items are frozen under the Capture lease and scrubbed with current rules;
opaque legacy windows are not split by guessing prose boundaries.

Excerpts use verified human user rows, excluding generated reminders,
notifications, skill wrappers and local-command output. Slash-command names and
arguments retain their exact original spans and whitespace. Repeated text may
retain unanimous human origin without assigning an ambiguous UUID. No model
chooses or paraphrases excerpts. Stable `u<raw-message-id>` ids and raw pointers
address them, and every retained span is checked against its human source.

Every human-authored user message is kept, regardless of its first words. No
keyword classifier selects survivors. Generated rows are identified by `isMeta`,
complete command/system tags or the exact engine boilerplate sentence; ordinary
prose such as `Caveat:` is not a generated-row marker. Excerpts are historical
evidence; inclusion does not make every past request an instruction still in force.

An individual message exceeding its 4096-byte size target is shortened in the
middle, keeping its Unicode-safe head and tail with an explicit marker naming
the raw row. Retained spans are verbatim and checked against that row. A target
too small for both ends and the marker can overflow. `elidedExcerptIds` records
only messages whose middle was removed; no entire human message is omitted.

The header aims at 750 words and the document at 65536 UTF-8 bytes. These are
targets, not limits. The window yields oldest summaries first. Aggregate size
pressure never removes a human message; the raw remainder and handled tail also
remain. The document can overflow when its messages require it. The renderer
returns per-cut overflow bytes, header words, targets, omitted summary ids and
middle-elided message ids.

## Version-2 header

JSON contains these arrays in order, including empty arrays; every item has
nonempty `sources`:

1. `intent`: current intent.
2. `instructionsInForce`: excerpt pointers only, with no restated instruction text.
3. `decisions`: text and optional supersession pointers.
4. `taskState`: text, status (`done`, `in progress`, `blocked`) and provenance
   (`authorized by the user`, `proposed by the assistant`, `observed`, `unresolved`).
5. `procedure`: exact commands/queries, loop cadence/end conditions and verification.
6. `nextSteps`: ordered text and provenance, starting with the in-progress action.
7. `openThreads`: unresolved work.
8. `files`: files and status.
9. `errors`: errors and fixes.

Pointers are `[excerpt:<id>]`, `[raw:<cut-id>:<positive-message-id>]` and
`[sum:sum_<id>]`. A fork may cite `{ "quote": "exact original span" }`, resolved
only by a unique original match. Identifiers are validated and never scrubbed.
Free text and quoted evidence use current Capture rules; typed state/provenance
values retain their prescribed values. Version-1 headers remain readable.
Unavailable inputs may have null input/prompt hashes; answered records may not.

The prompt invents nothing and leaves out what sources do not show. It never
claims that the user gave no instruction or never asked/authorized something.
`unknown` is only a state value. Summary-only conclusions are `reported` unless
raw evidence confirms them. The latest source wins on disagreement, and the
change is stated. Each authorization retains its exact scope: one PR, once,
until a condition. One-off requests never become standing rules. Finishing or
clean-up never leads next steps, and remains a proposal unless an excerpt
authorizes it. Validation proves shape and citation syntax, not semantic truth.

Every citation, including supersession pointers, is resolved when the model
produces the header. Each item records `resolved`, `missing` or `ambiguous`, with
the individual source checks and matched original ids. Quotes matching multiple
originals are ambiguous and never guessed. The daemon recomputes this result
against the frozen cut before persisting `citations` on the arm record. Shadow
outcomes remain `answered` even when citations fail. C4 uses the single
`allCitationsResolved` predicate to refuse any missing or ambiguous citation;
absent resolution data also refuses.

## Arms and shared budget

`captureHeaderModel` reads `$.session.model()` once at the cut and freezes its
exact identifier. A uses `$.model.fork` over the session prefix, with extraction
rules and excerpts but no digested window. B/C use `$.model.complete` with the
same frozen prompt, hashes and output allowance: B uses the captured model;
C uses `sonnet`. Fork invocation precedes its first await; pair work can await
immutable remainder readiness independently of the caller.

All module work shares `sessionSummarizerMaxOutputTokens` through a stable module
owner keyed by session id, independent of dispatch facade identity. Spending
survives poller restarts. B/C reserve equal bounded allowances atomically;
ordinary jobs wait for pending reservations. An uncapped fork starts immediately
or records unavailable/refused and blocks later admission until settled. Its
overshoot is recorded; strict aggregate enforcement is impossible for fork.
Spending, including failed/invalid output, is charged before delivery. Known
unused allowance is released. Unknown usage consumes the full lease reservation
and sets `usageUnknown`; it never releases that allowance as zero spending.
Other concurrent reservations keep their allowance, and later admission uses
only the remaining conservative budget. A failed fallback retains unknown usage
even when a preceding attempt reported counters.

Attempts retain uncached input, output, cache-read and cache-creation counters,
including fork cache reads. Unknown prices remain unknown. API errors, empty
replies, abort, nothing-to-fork, invalid output, unavailable input, cap refusal
and unconfirmed calls remain distinct; no failed arm is substituted or regenerated.
A too-long fork retains the observed API classification; an arbitrary 400 does
not imply prompt-too-long. Provider exception bodies are omitted.

Declarations establish shapes, not background lifetime, fork snapshot timing,
effective fork model or provider concurrency. Installation must verify these live
and choose a dispatch or session-lifetime executor. Unload discards the in-memory
budget owner; persistence across unload is not claimed. Phase-1 triage measures
version-2 documents and overflow using deterministic excerpts. Continuation
judgment, superiority and default-on remain phase-2 work.
