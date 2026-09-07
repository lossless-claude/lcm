# Replay ledger redesign

**Status:** design, not implemented · **Date:** 2026-09-07

## The mismatch

`replay_ledger` records a compaction as one row: `(session_id, summary_id, fingerprint)`. A compaction is not one summary. Four consequences, each of which has to be handled somewhere:

| Reality | The row cannot express it |
|---|---|
| One `/compact` produces several summaries across depths | only a single `latestSummaryId` fits |
| A session can complete producing **no** summary | `summary_id = NULL` reads as a broken chain, destroying the resume anchor |
| A replay summary is later absorbed by a normal or hook-created condensed summary | a direct-membership check finds nothing to restore, and the parent is deleted anyway |
| The "unchanged" fingerprint counts rows compaction itself writes | every completed session looks changed and is replayed again |

Patching these individually keeps exposing the next one: they are the same defect from four angles.

## Decision: `--restart` wipes, it does not undo

The constraint that forces surgical undo is the promise that hook-written summaries survive `--restart`, by scoping deletes to replay-owned `summary_id`s. **That promise is dropped.**

**It cannot hold as written.** Mixing is the normal case: `findUncompacted` deliberately includes already-compacted conversations under replay —

```sql
AND (? OR COALESCE(s.sum_count, 0) = 0)   -- replay=1 → include already-summarised conversations
```

— so a replay routinely compacts on top of hook summaries, and a replay summary can absorb a hook summary as a parent. Scoped deletes then leave the conversation without its hook summaries anyway. The promise fails exactly where it was meant to hold.

**Dropping it is cheap.** Wiping summaries loses no information: messages are never deleted, and `context_items` is a projection over them, so everything wiped is re-derivable. The cost is LLM calls to re-summarise — money and time, not data.

The alternative — refusing `--restart` on conversations carrying non-replay summaries — keeps the guarantee, but since mixing is normal it would refuse almost every run.

`--restart` reports how many summaries it will discard before discarding them.

## The model

**`context_items` is a derived view.** Three facts:

1. **Compaction never deletes messages.** `SummaryStore.replaceContextRangeWithSummary` deletes only `context_items` rows in a range, inserts one summary item, and resequences ordinals. The only `DELETE FROM messages` is `ConversationStore.deleteMessages`, a separate redaction path.
2. **`messages.seq` is the authoritative order.** `context_items.ordinal` is a compacted projection of it.
3. **`summary_messages` records what each summary covers**, so a summary is invertible by construction.

So `--restart` rebuilds rather than inverts:

```
restart(conversation):
  DELETE FROM context_items WHERE conversation_id = ?
  INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
    SELECT ?, ROW_NUMBER() OVER (ORDER BY seq) - 1, 'message', message_id
    FROM messages WHERE conversation_id = ? ORDER BY seq
  -- then drop the summaries the run produced, with their parents/messages links
```

No lineage walk, no expansion, no ordinal splicing. No such helper exists today.

### The rebuild must exclude compaction events

`CompactionEngine.persistCompactionEvent` writes its `"LCM compaction leaf pass…"` row into `messages` + `message_parts` but never into `context_items` — `appendContextMessage` has no callers outside its own definition. A naive `INSERT … SELECT FROM messages` would therefore surface compaction noise into the model's context, a regression the current code does not have. The rebuild filters on the `part_type = 'compaction'` predicate below, and the wipe deletes those now-stale event rows.

### The ledger row

```sql
CREATE TABLE replay_ledger (
  run_id              TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  position            INTEGER NOT NULL,
  content_fingerprint TEXT NOT NULL,
  summary_id          TEXT,            -- nullable; threading anchor only
  outcome             TEXT NOT NULL,   -- 'compacted' | 'no_work'
  completed_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, session_id)
);
```

`prev_session_id` goes, as does the separate per-summary table. `summary_id` survives but stops being what `--restart` deletes.

The migration is **additive** — `.github/skills/code-review/SKILL.md` §7 forbids destructive DDL — so retired columns stay in the schema and simply stop being written.

- **Resume** — skip rows whose fingerprint matches *and* that precede the first gap.
- **Restart** — for each session in the run's manifest: wipe that conversation's summaries, rebuild `context_items`, delete its ledger rows.

### The fingerprint discriminator

Counting source messages while excluding compaction events has a factual answer, not a design choice.

`CompactionEngine.persistCompactionEvent` writes its event row with `role: "system"`, so `WHERE role != 'system'` looks right — but `parseTranscript()` also accepts `system` and the ingest route persists it, so that over-excludes genuine transcript messages. The same method attaches a message part with `partType: "compaction"`. That is exact:

```sql
WHERE NOT EXISTS (
  SELECT 1 FROM message_parts p
  WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
)
```

That part's `metadata` already carries `createdSummaryIds` — the information a separate ledger table would exist to store is already recorded.

## Cross-session threading — kept

`previous_summary` continues to cross sessions; it is worth the per-project chain bookkeeping.

Resume must therefore re-establish the chain in a fresh process, which is why `summary_id` stays as a nullable anchor. A `no_work` row with a NULL anchor is complete and valid — the anchor search walks further back to the most recent non-null one rather than treating it as a broken chain.

**Anchor rule.** Implicit today: `getSummariesByConversation` orders `BY created_at` and the `else if (allSummaries.length > 0)` fallback in `createCompactHandler` takes the last element. Formalised: *the anchor is the most recently created summary of that conversation, regardless of depth.*

## Not covered

The manifest model (`replay_manifest`, frozen order, appends on adoption) is sound and survives unchanged, as does the suffix-resume rule that replays everything after the first incomplete position. This redesign touches the ledger and `--restart` only.
