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

Native/arm delivery takes `cwd`, `session_id`, `cut_id`, `snapshot_hash` and `record`;
arm delivery also takes `arm` and `attempt_id`. Usage retains uncached input, output,
cache-read and cache-creation counters. Missing usage or cost is unknown, never zero.
Identical retries are accepted; conflicting results or identities are rejected.
Independent files and atomic publication preserve out-of-order completion. Once
native and all three arms have records, the manifest is complete even when an arm
reports a non-answer.

Persisted text uses Capture's global/project scrubbing rules. Engine descriptors
allow only role, text and opaque handle; arbitrary result objects and media bytes
are omitted. Artifacts have private file/directory permissions. Nothing uploads
them; later model calls through the session client can still transmit prompts.

Cuts expire after 30 days. Startup and admission prune expired cuts in bounded
update batches, only in this namespace, and mark another daemon owner's pending
cuts incomplete. Delivery to an expired cut is rejected. A local evaluation export
has its own lifetime. Cleanup does not follow directory links.

## Corpus policy

`bench-corpora.json` is an evaluation policy, not a prerequisite for shadow mode.
Admission uses a valid existing policy to skip excluded projects before Capture;
missing or invalid policy leaves admission available. Paths and cwd substrings use
the shared canonical, case-insensitive benchmark rules. A candidate cwd can resolve
a substring policy before its first capture.

The offline evaluator requires a valid explicit policy and excludes projects from
metadata before loading transcripts or artifacts. Exclusions take precedence over
holdout. Missing or unresolvable corpus identity is not eligible for evaluation.
