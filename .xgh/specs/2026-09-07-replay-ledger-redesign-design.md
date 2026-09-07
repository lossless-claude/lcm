# Replay ledger redesign

**Status:** design, not implemented · **Supersedes:** the ledger model in PR #302 (now draft)
**Date:** 2026-09-07

## Why this exists

PR #302 went through two Codex review rounds. Round 1 filed 13 findings (10 P1); all 13 were addressed in `e6007b3` and the diff was sound on its own terms. Round 2 on `aa57b3f` filed 10 more (7 P1) — and **four were the same findings re-raised**, meaning the round-1 fix had not actually closed them. One P1 was *created* by the round-1 fix. That is not a patch queue converging; it is a model that does not fit.

## The mismatch, in one line

`replay_ledger` records a compaction as **one row: `(session_id, summary_id, fingerprint)`**. A compaction is not one summary.

Every recurring P1 is a place where that shape is too narrow:

| Reality | Row can't express it | Finding |
|---|---|---|
| One `/compact` produces several summaries across depths | only `latestSummaryId` fits | `db/migration.ts:650` |
| A session can complete producing **no** summary (`no_work`) | row records `summary_id = NULL`, destroying the resume anchor | `import.ts:440` (introduced by the round-1 fix) |
| A replay summary is later absorbed by a normal/hook condensed summary | direct-membership check restores nothing, then the parent is deleted anyway | `replay-resume.ts:642` |
| The "unchanged" fingerprint is computed over rows compaction itself writes | every completed session looks changed | `batch-compact.ts:274`, `batch-compact.ts:72` |

Patching each symptom keeps exposing the next one because they are the same defect seen from four angles.

## The fork: is the "untouched summaries" promise worth keeping?

The constraint that forces all the surgery is stated in **PR #302's own description**, not in `AGENTS.md` or any pre-existing repo contract:

> `--restart` (new flag on both commands) deletes ledger rows and the summaries they recorded — **hook-written summaries are untouched** since deletes are scoped to ledger `summary_id`s.

(Codex's `AGENTS.md:L78` citations point at the generic "Doc/code alignment" review bullet, not at a summary-lifetime guarantee. There is no older promise to honour.)

Keeping that promise is what requires walking `summary_parents` lineage, expanding summaries back into their source messages, and splicing `context_items` in place — the machinery that has not converged.

**This is Pedro's call and it decides the rest of the design.** Two options, in §"Open questions".

## The model, if the promise is relaxed

**`context_items` is a derived view.** Three facts make this true today:

1. **Compaction never deletes messages.** `replaceContextRangeWithSummary` (`src/store/summary-store.ts:617`) deletes only `context_items` rows in a range, inserts one summary item, and resequences ordinals. The only `DELETE FROM messages` in the codebase is `ConversationStore.deleteMessages`, a separate redaction path.
2. **`messages.seq` is the authoritative order.** Ingest appends in `seq` order; `context_items.ordinal` is a compacted projection of it.
3. **`summary_messages` records exactly what each summary covers**, so a summary is invertible by construction.

Therefore `--restart` does not need to *invert* anything:

```
restart(conversation):
  DELETE FROM context_items WHERE conversation_id = ?
  INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
    SELECT ?, ROW_NUMBER() OVER (ORDER BY seq) - 1, 'message', message_id
    FROM messages WHERE conversation_id = ? ORDER BY seq
  -- then drop the summaries the run produced, with their parents/messages links
```

No lineage walk, no expansion, no ordinal splicing, no cache keyed by the wrong thing. Roughly 20 lines; no such helper exists today (`grep -rn "DELETE FROM context_items" src/` returns only the two call sites above).

### The ledger row becomes

```sql
CREATE TABLE replay_ledger (
  run_id             TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  position           INTEGER NOT NULL,
  content_fingerprint TEXT NOT NULL,
  outcome            TEXT NOT NULL,   -- 'compacted' | 'no_work'
  completed_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, session_id)
);
```

Gone: `summary_id`, `prev_session_id`, and the whole `replay_ledger_summaries` table added in round 1.

- **Resume** = skip rows whose fingerprint matches *and* that precede the first gap (the `seenGap` rule from round 1 is right and survives).
- **Restart** = for each session in the run's manifest: wipe that conversation's summaries, rebuild `context_items`, delete its ledger rows.
- **Threading** needs no stored column. "The latest summary content for the last done session's conversation" is a query against `summaries` at plan time, not state carried in the ledger.

### The fingerprint has an exact discriminator

Both fingerprint findings reduce to one question — *how do I count source messages while excluding compaction events?* — and it has a factual answer, not a design choice.

`CompactionEngine` writes its event row as `role: "system"` (`src/compaction.ts:1327`), which is why the round-1 fix used `WHERE role != 'system'`. Codex correctly rejected that: `parseTranscript()` also accepts `system` and the ingest route persists it, so genuine transcript system messages get excluded too.

But the event row also gets a message part with **`part_type = 'compaction'`** (`src/compaction.ts:~1335`). That is exact:

```sql
WHERE NOT EXISTS (
  SELECT 1 FROM message_parts p
  WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
)
```

(Side note: that part's `metadata` already carries `createdSummaryIds`. The information the round-1 ledger table was invented to store already exists — another sign the table was the wrong answer.)

## What this does to the round-2 findings

| Finding | Under the rebuild model |
|---|---|
| `db/migration.ts:650` — only final `latestSummaryId` retained | **Dissolves.** No summary ids in the ledger at all. |
| `import.ts:440` — `no_work` records `summary_id = NULL`, kills the anchor | **Dissolves.** No anchor concept; `outcome` is a first-class column. |
| `replay-resume.ts:642` — sources hidden beneath surviving summaries | **Dissolves.** No expansion; rebuild from `messages`. |
| `batch-compact.ts:274` — unstable batch fingerprint | **Collapses** into the `part_type = 'compaction'` predicate. |
| `batch-compact.ts:72` — `role = 'system'` over-excludes | **Same predicate.** One fix, both findings. |
| `batch-compact.ts:156` — `batchCompact()` never sends `previous_summary` | **Ordinary bug.** Independent of the ledger model. |
| `replay-resume.ts:509` — restored chains collapse across projects | **Ordinary bug.** Per-`cwd` map; round-1 fix was on the right track. |
| `import.ts:276` — `provider: "all"` clears replay state twice | **Ordinary bug.** Guard the clear per `(cwd, command)` for the whole `importSessions` call. |
| `cli/pipeline-runner.ts:76` — second SIGINT discarded | **Unrelated.** Separate commit. |
| `docs/architecture.md:113` — fingerprint doc drift | **Unrelated.** Separate commit (docs say size + line count + mtime; `fingerprintFile` persists size + floored mtime). |

Three P1s vanish. Two collapse into one predicate. Three are plain bugs. Two are unrelated hygiene. That is what convergence looks like.

## Open questions for Pedro

**Q1 — the promise.** Does `--restart` have to leave hook-written summaries in the same conversation untouched?

- **(a) No — replay owns the conversations it touches.** `--restart` wipes that conversation's summaries and rebuilds `context_items`. Simplest; everything above follows. Cost: a conversation compacted by both a hook and a replay loses its hook summaries on restart.
- **(b) Yes — but enforce it by refusal, not surgery.** Replay *skips* conversations that already carry non-replay summaries unless `--force`; `--force` means option (a) for those conversations. The promise is kept, and the unconverged lineage machinery is still deleted.

I would take **(b)**: it keeps the guarantee the PR advertised, costs one predicate at plan time, and still lets the whole expansion/splice path go. (a) is defensible if replay-and-hooks-on-the-same-conversation is not a real scenario — you know that better than I do.

**Q2 — cross-session threading.** Is `previous_summary` threading *across sessions* worth keeping at all? It is the source of the per-project chain bugs, the "broken chain" warnings, and the `prev_session_id` column. If each session compacts independently, several findings stop existing. If it materially improves summary quality, it stays — but then it should be a plan-time lookup against `summaries`, never ledger state.

## Not covered here

The manifest model (`replay_manifest`, frozen order, appends on adoption) is sound and survives unchanged, as does the `seenGap` suffix-resume rule. This redesign touches the ledger and `--restart` only.
