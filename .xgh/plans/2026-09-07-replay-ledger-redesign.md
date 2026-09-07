# Replay ledger redesign — implementation plan

**Spec:** `.xgh/specs/2026-09-07-replay-ledger-redesign-design.md` · **Date:** 2026-09-07

## Approach

Rework the `copilot/make-replay-resumable` branch in place. The manifest model, the suffix-resume rule and the SIGINT drain are sound and survive; what comes out is the ledger's summary bookkeeping and the `--restart` lineage machinery.

Steps 1–4 are the redesign. Steps 5–7 are bugs independent of the model and can land in any order. Step 8 lands in this PR: both items exist only on this branch.

---

## 0. Decisions that shape the steps

**Threading stays.** `previous_summary` continues to cross sessions, so steps 6–7 are in scope.

**`summary_id` stays as a nullable anchor-only column.** Resume must re-establish the chain in a fresh process; keeping the column is fewer moving parts than re-deriving it by query. Its purpose changes: it is no longer what `--restart` deletes. A `no_work` row with a NULL anchor is then complete and valid, and the anchor search walks further back.

**Anchor rule.** `getSummariesByConversation` orders `BY created_at` and the `else if (allSummaries.length > 0)` fallback in `createCompactHandler` takes the last element. Written down: *the anchor is the most recently created summary of that conversation, regardless of depth.*

**Migrations stay additive.** `.github/skills/code-review/SKILL.md` §7 forbids destructive DDL, so nothing below drops a table or column.

## 1. Adjust the ledger schema

**`src/db/migration.ts`**

- Add the outcome column, guarded for idempotency (check `PRAGMA table_info(replay_ledger)` the way `ensureSummaryDepthColumn` does):
  ```sql
  ALTER TABLE replay_ledger ADD COLUMN outcome TEXT NOT NULL DEFAULT 'compacted';
  ```
- Remove the `CREATE TABLE IF NOT EXISTS replay_ledger_summaries` block and its index so new databases never get it. **Do not `DROP` it** — existing dev databases keep a harmless orphan table.
- `prev_session_id` and `model` stay in the schema as nullable columns but stop being written. `summary_id` stays and keeps being written, as the threading anchor.

Resulting row: `(run_id, session_id, position, content_fingerprint, summary_id?, outcome, completed_at)`.

## 2. Add the wipe-and-rebuild helper

**`src/store/summary-store.ts`** — new method; no wipe path exists today.

```ts
async resetConversationContext(conversationId: number): Promise<number>
```

Pair it with a read-only `countSummaries(conversationId)`, so `--restart` can report the total **before** wiping — the reset method can only count after the fact.

In one transaction:

1. Collect `summary_id`s for the conversation.
2. `DELETE FROM summary_messages WHERE summary_id IN (...)`
3. `DELETE FROM summary_parents WHERE summary_id IN (...) OR parent_summary_id IN (...)`
4. `DELETE FROM context_items WHERE conversation_id = ?`
5. `DELETE FROM summaries WHERE conversation_id = ?`
6. Delete the now-stale compaction-event messages — they describe summaries that no longer exist:
   ```sql
   DELETE FROM messages WHERE conversation_id = ? AND EXISTS (
     SELECT 1 FROM message_parts p
     WHERE p.message_id = messages.message_id AND p.part_type = 'compaction'
   )
   ```
7. Rebuild, **excluding compaction events**:
   ```sql
   INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
   SELECT ?, ROW_NUMBER() OVER (ORDER BY m.seq) - 1, 'message', m.message_id
   FROM messages m
   WHERE m.conversation_id = ?
     AND NOT EXISTS (
       SELECT 1 FROM message_parts p
       WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
     )
   ORDER BY m.seq
   ```

The exclusion is mandatory: event rows have never been in `context_items`, so an unfiltered rebuild would surface `"LCM compaction leaf pass…"` into the model's context. Step 6 makes step 7's predicate redundant — keep both, so step 7 stays correct on its own.

Check the FTS5 mirror: `deleteMessageFromFullText` exists for messages; confirm whether summaries have an equivalent index needing the same treatment, and call it for both the summaries and the deleted event rows.

## 3. Rewrite `clearReplayState`

**`src/replay-resume.ts`** — delete `loadReplaySummaryIds`, `expandSummaryToMessageIds`, `restoreContextFromReplaySummaries`, and every `UNION ALL` subquery over the ledger tables.

Replace with: resolve the conversations for the run's manifest sessions → `resetConversationContext` on each → delete the run's `replay_ledger` rows. Keep the `missing` / `error` / `ready` distinction in `openProjectDb` — it is what lets `clearReplayState` return `false` on an unusable database rather than silently reporting success.

Run `countSummaries` over the affected conversations first and print the total, then wipe.

## 4. Record `outcome`; keep `summary_id` as the anchor

**`src/import.ts`, `src/batch-compact.ts`** — `recordReplayProgress` loses `summaryIds` and `prevSessionId`, gains `outcome: "compacted" | "no_work"`, and keeps `summaryId` (nullable). Keep the `replayOutcome` gating that prevents disabled compactions being recorded as done.

**Resume anchor lookup** in `planProject`: from the last done row before the first gap, walk backwards to the most recent row with a non-null `summary_id` and load its content. A run of `no_work` rows is skipped, not treated as a broken chain.

**`src/daemon/routes/compact.ts`** — drop `latestSummaryIds` from the response; keep `latestSummaryContent` (threading), `latestSummaryId` (ledger) and `replayOutcome`. The `else if (allSummaries.length > 0)` fallback stays, now as the documented anchor rule.

**`src/compaction.ts`** — `createdSummaryIds` on `CompactionResult` is no longer read by replay. Keep it in the compaction-event `metadata`; drop it from the route response only.

## 5. Fix the fingerprint predicate

**`src/batch-compact.ts`** — `findUncompacted`'s `source_messages` / `source_tokens` subquery uses `role != 'system'`, which over-excludes: `parseTranscript()` accepts `system` and the ingest route persists it. Use the exact discriminator:

```sql
LEFT JOIN (
  SELECT conversation_id, COUNT(*) AS msg_count, SUM(token_count) AS raw_tokens
  FROM messages m
  WHERE NOT EXISTS (
    SELECT 1 FROM message_parts p
    WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
  )
  GROUP BY conversation_id
) src ON src.conversation_id = c.conversation_id
```

Add a test that compacts twice and asserts the fingerprint is unchanged.

## 6. Send `previous_summary` from `batchCompact`

The `/compact` request must carry `previous_summary` from `previousSummaryByCwd`, and the response's `latestSummaryContent` must write back into it. Verify against the current branch state rather than assuming an earlier edit landed correctly.

## 7. Per-project chain state and double-clear

- **`src/replay-resume.ts`** — confirm every consumer reads the per-`cwd` `restoredPreviousSummaries` map, and that the single-value `restoredPreviousSummary` / `droppedPreviousSummary` fields are removed rather than merely shadowed.
- **`src/import.ts`** — with `provider: "all"`, `ingestSessionList()` runs twice. Hoist the `--restart` clear into `importSessions`, or guard it with a per-`(cwd, command)` set for the whole call, so a shared `cwd` is cleared once.

## 8. Signal handling and docs — same PR

- **`src/cli/pipeline-runner.ts`** — a second SIGINT/SIGTERM is discarded, so a hung daemon POST cannot be interrupted. Let the second signal force exit.
- **`docs/architecture.md`** — the doc describes a size + line-count + mtime fingerprint; `fingerprintFile` persists size + floored mtime.

---

## Tests

- `test/replay-resume.test.ts` — replace summary-id assertions with `outcome`; add: restart on a conversation carrying both hook and replay summaries wipes both and rebuilds `context_items` from `messages` in `seq` order.
- New: fingerprint stability across two consecutive compactions of an unchanged conversation.
- New: `provider: "all"` with a shared `cwd` clears replay state exactly once.
- Keep the existing suffix-resume tests unchanged.

## Verification

`npm run typecheck` and `npm test`. Two pre-existing unrelated failures have been observed on this branch: `test/daemon/routes/restore.test.ts` and `test/daemon/routes/stats.test.ts` (the latter a 60s `/stats` timeout).

## Daemon race on `--restart`

`--restart` runs in the CLI process and wipes summaries; the daemon's `compactingNow` guard is per-request and in-process, so nothing serialises the two. Decision: document the assumption in `docs/architecture.md` (run `--restart` with the daemon idle). Refusing `--restart` while a daemon lock is held is a follow-up issue.

## Docs to update in the same PR

- The pull request description — the "hook-written summaries are untouched" claim is now false and must be replaced with the wipe semantics.
- `docs/architecture.md` — replay/restart section, if one exists.
- Help text for `--restart` on both `import` and `compact`: it discards **all** summaries in the conversations the run touched.
