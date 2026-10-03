# Compaction shadow artifacts

Shadow measurement stores alternative compaction documents beside native's result.
It does not install a document, change restore, regenerate the DAG or enable model
calls. A live hook and its executor are separate work; their lifetime and fork/native
concurrency require verification in the engine.

## Admission and storage

The authenticated daemon routes are `POST /compaction-shadow/start`, `/native` and
`/arm`. Start takes `cwd`, `session_id`, a nonce `cut_id`, `boundary_uuid`, `model`,
`trigger` (`manual`, `auto`, `plugin`) and optional `instructions`, `transcript_path`
and `engine_messages`. The transcript must identify the requested session. Capture
must be verified, complete and end at the specified model-visible UUID.

Admission snapshots the current complete window and its exact lineage under the
project mutation lease, preserving all raw roles. It rejects unavailable coverage,
post-cut content, source changes and windows beyond the existing 65536-byte bound.
It does not run a summary sweep. Native PreCompact continues using its configured
pipeline. The source index uses unique role/text matches for UUID/origin evidence;
ambiguous repeated text remains unknown instead of being assigned by counting.

Each cut lives under `projects/<project-id>/compaction-shadow/<cut-id>/` in the lcm
home, independently of episodic storage. `manifest.json` records cut identity,
source boundary, model, snapshot/scrubbing hashes, timestamps and expected arms.
`snapshot.json` freezes captured originals, the window/coverage and safe engine
descriptors. `native.json` preserves observed summary text and tail, a pre-scrub text
hash/byte count, optional usage and timing. `arm-<A|B|C>-<attempt-id>.json` records
header/output, input/prompt hashes, outcome, model, timing and usage attempts.
Arm records optionally preserve HTTP status, a bounded API error kind and known
completion `maxTokens`/`effort`; provider error bodies are not stored. A failed arm
is an experimental outcome, not a reason to regenerate another model's output.

Native/arm delivery takes `cwd`, `session_id`, `cut_id`, `snapshot_hash` and `record`;
arm delivery also takes `arm` and `attempt_id`. Usage retains uncached input, output,
cache-read and cache-creation counters. Missing usage or cost is unknown, never zero.
Identical retries are accepted; conflicting results or identities are rejected.
`requestIdentityHash` binds the raw cwd, cut nonce, session, boundary, model,
trigger and instruction presence/value before redaction. Only its SHA-256 digest
is stored beside the scrubbed display fields. A retry cannot change those inputs,
even when both redact to the same text. Legacy cuts without this digest remain
readable for evaluation and expiry, but admission retries require a new cut nonce.
Independent files and atomic publication preserve out-of-order completion. Once
native and all three arms have records, the manifest is complete even when an arm
reports a non-answer.

Every persisted text field, including frozen windows and historical summary text,
uses Capture's current global/project scrubbing rules. Scrubbing the shadow copy
does not rewrite stored DAG summaries. Engine descriptors
allow only role, text and opaque handle; arbitrary result objects and media bytes
are omitted. Correlation identifiers are 1–140 ASCII letters, digits, underscores
or hyphens, and are rejected if current scrubbing rules flag them. Accepted handles,
session/cut/boundary/source/attempt identifiers, supersession ids and source pointers
retain their exact values. Source pointers must use `[raw:<cut-id>:<positive-id>]`
or `[sum:<summary-id>]` with a `sum_` prefix; quoted evidence uses `{ "quote": "..." }`. Caller-supplied
digests and error kinds retain their stricter shapes and are also checked for
sensitive values. Model labels use the identifier shape and are scrubbed for display.
Artifacts have private file/directory permissions. Nothing uploads
them; later model calls through the session client can still transmit prompts.

Cuts expire after 30 days. Startup and admission prune expired cuts in bounded
update batches, only in this namespace, and mark another daemon owner's pending
cuts incomplete. Delivery to an expired cut is rejected. A local evaluation export
has its own lifetime. Recovery checks every descended directory with `lstat`,
including project, shadow and cut directories, and skips links. Every recursive
removal, including staging cleanup, rechecks the directory chain and verifies its
real path is strictly inside the lcm home's real projects directory.

## Corpus policy

`bench-corpora.json` is an evaluation policy, not a prerequisite for shadow mode.
Admission uses a valid existing policy to skip excluded projects before Capture;
missing or invalid policy leaves admission available. Paths and cwd substrings use
the shared canonical, case-insensitive benchmark rules. A candidate cwd can resolve
a substring policy before its first capture.

The offline evaluator requires a valid explicit policy; present exclusion and
holdout fields must be lists, including when empty. Null is invalid. Projects are
excluded from metadata before loading transcripts or artifacts. Each transcript's
own leading recorded absolute `cwd` determines ownership, including explicit
manifest entries. A directory name cannot establish ownership because Claude
directory names can collide. Transcripts without readable ownership metadata in
the first 4096 bytes are ineligible. The probe skips leading records without cwd
without decoding their payloads. Exclusions take precedence over holdout.
Missing or unresolvable corpus identity is not eligible for evaluation.

## Phase-1 triage

The repository tool `scripts/eval-compaction-shadow.mts` reads built evaluator
modules, frozen shadow cuts and native JSONL `isCompactSummary` records. It makes
no model, daemon, retrieval or database call. See configuration for invocation.
Sampling is seeded by project, session and cut, targeting at least 30 cuts across
3 allowed projects. Smaller samples are reported as insufficient. Existing
historical cuts have no invented arms or reconstructed current DAG window.

Historical originals require explicit `parentUuid` ancestry before the summary.
Every ancestor must precede its child in transcript row order;
compact boundaries and prior summary rows are not probe sources. Unresolvable,
cyclic or incomplete transcripts are invalid sources. Source UUID/boundary and
pre-scrub hash/byte count pair hook-observed native text with decoded JSONL text.
Whitespace is significant; a mismatch disables native comparison for that cut.

Every probe preserves a verbatim real user message and source address before the
cut. Exact quote retention is a recall proxy. A versioned lexical classifier
checks paths, issue numbers, summary ids, code identifiers and recognized command
forms against captured originals; pointer resolution uses frozen raw/DAG lineage.
Directive paraphrases fail the verbatim check. A valid generated summary pointer
can still fail the strict literal identifier floor; these results are separate.
Presence does not prove relationships, negation or task status.

Outputs are `selection.json`, `probes.jsonl`, `metrics.json`, `report.md` and a hash
`manifest.json`. Current Capture rules re-scrub source text without rewriting
identity, role, usage or outcome metadata. Sizes describe scrubbed text, not the
complete hidden tool/media state kept by an opaque engine handle.

Optional prices have a `version` and `models` map keyed by reported requested model;
each model has `inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion` and
`cacheCreationPerMillion`. Estimates retain failed-attempt spending and exact cache
counters. Unknown usage/model/rates remain unknown. Native cost needs reported
charge evidence; it is not inferred from another arm's model. DAG/retrieval cost
attribution is unavailable, so this tool cannot establish an amortized-cost gate.

Continuation scoring returns `not-run/phase-2`, with the frozen rubric hash and
version. Phase 2 requires frozen source/DAG/retrieval/environment, held-out sessions
and human calibration. Superiority and default-on are not phase-1 conclusions.
