# Search memory with QMD

LCM includes the QMD 2.8.3 SDK as an optional search backend. LCM keeps the source messages,
summaries and promoted memories; QMD indexes a derived copy for retrieval. Native search remains
the default. This first integration is explicit: importing or storing a memory does not automatically
rebuild the QMD index, and automatic prompt hints continue using their existing policy.

## Start with lexical search

From the project whose memories you want to search:

```sh
lcm index
lcm search "indexing decision" --backend qmd
```

`lcm index` projects retained messages, summaries and promoted memories, including manually stored
notes, then updates the QMD lexical index. It does not run a model. Unchanged evidence files are
left untouched; removed source records are removed from the managed projection on the next index.
Empty or whitespace-only source records are not projected.
Use `lcm index --project /path/to/project` to index another project explicitly.

The source database must already exist. Import sessions or store a memory first. No source text is
sent to a remote inference provider by this backend.

## Enable hybrid search

```sh
lcm index --embed
lcm search "why did we move indexing out of the daemon?" --backend qmd --mode hybrid
```

Embedding and hybrid search use QMD's local models. The first call may download models and take
longer than a warm query. `--embed` prepares document embeddings; hybrid search also uses query
expansion and reranking models. The published QMD defaults require roughly 2 GB of model downloads,
plus runtime memory. This integration currently uses those SDK defaults; it does not reuse LCM's
summarizer configuration or a remote Qwen endpoint. Package and model storage are separate.

Hybrid search requires a fully embedded QMD index. After importing or changing memories, run
`lcm index --embed` again. Lexical search remains available without embeddings.
For a large initial corpus, extend the indexing budget explicitly, for example
`lcm index --embed --timeout 3600` (one hour; maximum 86400 seconds).

## Read the result

QMD responses identify `backend: "qmd"` and contain a single ranked `matches` list. Each match
contains a bounded exact source snippet, kind, canonical identifiers, a revision-bound `ref`, its
`sourceHash`, and a `span` measured in JavaScript UTF-16 character positions. A summary match is
the stored summary text, not a claim that it is an original transcript quotation. The current
`createdAt` is the existing LCM record timestamp; do not interpret it as historical event time.

The response includes the projection revision, embedding capabilities, candidate count and cap,
and `staleCount`. `partial` is true when stale candidates were rejected or the candidate cap was
reached. Source filtering can reduce the result count. These diagnostics do not certify that every
available Claude/Codex session was imported or that newly added evidence is already indexed.

`--limit` means a total result count for QMD (1–100), while native search retains its per-layer
meaning. `--layer episodic|promoted` and repeated `--tag` options still apply. Promoted tags are
checked against current source records; episodic records without tags do not match a tag filter.

Source records are revalidated before results are returned. A changed, archived or deleted source
is not returned merely because QMD still has an old copy. New or changed evidence is not searchable
through the old projection until indexing runs again. Indexing failure is not silently treated as a
completed update.

## Fallback and operations

If QMD is unavailable, not indexed, missing embeddings, or times out, `lcm search --backend qmd`
returns native results with `backend: "native"`, `fallback: true`, and an `errors` explanation.
Inspect those fields when evaluating quality; a fallback result is not a QMD measurement.
`lcm index` reports indexing failures directly.

Native QMD/SQLite/model work runs in a separate worker. The daemon keeps one active QMD project
store, closing it when another project is selected. Lexical requests currently have a 10-second
worker timeout, hybrid requests 120 seconds and indexing 10 minutes by default (`--timeout` overrides it). Requests wait in a bounded
queue; a waiting search may expire without cancelling an active index. Cold model downloads can
exceed a request timeout; retry after resolving connectivity or model availability. A timeout
terminates the worker; later calls can start a new one. The daemon closes its worker on shutdown.

Derived files live under `~/.lossless-claude/projects/<project-hash>/qmd/`, separate from `db.sqlite`.
Only QMD-managed evidence files are removed by indexing. SDK/native libraries add installation
and memory costs; the lexical path requires no model download.

## MCP

The existing `lcm_search` tool accepts `backend: "qmd"` and `mode: "lexical" | "hybrid"`.
Prepare the index with the CLI first. Native responses retain their existing layer lists; QMD
responses use `matches`. No additional MCP tool is required.

## Evaluation status

This is an Adapter integration, not a claim that QMD improves recall on your corpus. Compare
reviewed queries on the same indexed source snapshot and inspect fallback/partial fields. The
existing `lcm bench` runner still measures native retrieval; it does not select QMD automatically.
See the [design and adoption criteria](./design/qmd-assessment.md) before publishing quality scores.
