# Replay ledger redesign — implementation plan

**Spec:** `.xgh/specs/2026-09-07-replay-ledger-redesign-design.md`
**Supersedes:** the ledger implementation in PR #302 (draft)
**Date:** 2026-09-07

## Approach

Rework `copilot/make-replay-resumable` in place rather than starting a new branch — the manifest model, the `seenGap` suffix-resume rule and the SIGINT drain work are sound and should survive. What comes out is the ledger's summary bookkeeping and the `--restart` lineage machinery.

Steps 1–4 are the redesign. Steps 5–7 are ordinary bugs Codex found that are independent of the model; they can land in any order. Step 8 is unrelated hygiene and should be its own PR.

---

## 1. Shrink the ledger schema

**`src/db/migration.ts`**

- Drop the `replay_ledger_summaries` table added in round 1 (`CREATE TABLE IF NOT EXISTS` — remove the block and its index).
- `replay_ledger` becomes:
  ```sql
  CREATE TABLE IF NOT EXISTS replay_ledger (
    run_id              TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    position            INTEGER NOT NULL,
    content_fingerprint TEXT NOT NULL,
    outcome             TEXT NOT NULL,   -- 'compacted' | 'no_work'
    completed_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, session_id)
  );
  ```
  Removed: `summary_id`, `prev_session_id`, `model`.

**Migration note:** the branch is unreleased, so existing `replay_ledger` rows only exist on dev machines that ran the branch. Prefer dropping and recreating the table over an `ALTER` chain — but confirm that assumption before writing it.

`model` moves to (or stays on) `replay_manifest`, which is where the run-level "last run's model" line is read from anyway. Verify `loadLatestRun` still resolves it.

## 2. Add the wipe-and-rebuild helper

**`src/store/summary-store.ts`** — new method, since no wipe path exists today (`grep -rn "DELETE FROM context_items" src/` returns only `replaceContextRangeWithSummary` and the redaction path in `conversation-store.ts`).

```ts
async resetConversationContext(conversationId: number): Promise<number>
```

In one transaction:
1. Collect `summary_id`s for the conversation; return the count (the caller reports it).
2. `DELETE FROM summary_messages WHERE summary_id IN (...)`
3. `DELETE FROM summary_parents WHERE summary_id IN (...) OR parent_summary_id IN (...)`
4. `DELETE FROM context_items WHERE conversation_id = ?`
5. `DELETE FROM summaries WHERE conversation_id = ?`
6. Rebuild:
   ```sql
   INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
   SELECT ?, ROW_NUMBER() OVER (ORDER BY seq) - 1, 'message', message_id
   FROM messages WHERE conversation_id = ? ORDER BY seq
   ```

Check the FTS5 mirror: `deleteMessageFromFullText` exists for messages — confirm whether summaries have an equivalent index that also needs clearing.

## 3. Rewrite `clearReplayState`

**`src/replay-resume.ts`**

Delete outright:
- `loadReplaySummaryIds`
- `expandSummaryToMessageIds`
- `restoreContextFromReplaySummaries`
- every `UNION ALL` subquery over `replay_ledger` + `replay_ledger_summaries`

Replace with: resolve the conversations for the run's manifest sessions → `resetConversationContext` on each → delete the run's `replay_ledger` rows. Keep the `missing` / `error` / `ready` distinction from round 1 — it was right, and it is what makes `clearReplayState` return `false` on an unusable database.

Sum the returned counts and surface them: `--restart` prints how many summaries it is discarding **before** doing it (spec requirement).

## 4. Record `outcome` instead of summary ids

**`src/import.ts`, `src/batch-compact.ts`**

`recordReplayProgress` loses `summaryId`, `summaryIds`, `prevSessionId`; gains `outcome: "compacted" | "no_work"`. The `replayOutcome` gating from round 1 stays — it is the fix for "disabled compactions recorded as done" and is independent of this rework.

This dissolves `import.ts:440` (a `no_work` session no longer needs a `summary_id` to be a valid resume point).

**`src/daemon/routes/compact.ts`** — `latestSummaryIds` can go from the response; `latestSummaryContent` stays (threading still needs it). Keep `replayOutcome`.

**`src/compaction.ts`** — `createdSummaryIds` on `CompactionResult` is now unused by replay. It is still written into the compaction-event `metadata`; decide whether to keep it there (harmless, and useful for debugging) or drop it.

## 5. Fix the fingerprint predicate (2 findings)

**`src/batch-compact.ts`** — `findUncompacted`'s `source_messages` / `source_tokens` subquery currently uses `role != 'system'`, which over-excludes: `parseTranscript()` accepts `system` and the ingest route persists it.

Use the exact discriminator instead — the compaction event's message part (`src/compaction.ts:1327` writes `role: "system"`, then a part with `part_type: "compaction"`):

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

Closes `batch-compact.ts:274` and `batch-compact.ts:72` together. Add a test that compacts twice and asserts the fingerprint is unchanged.

## 6. Send `previous_summary` from `batchCompact`

**`src/batch-compact.ts:156`** — Codex re-raised this on `aa57b3f`, so verify against the current branch state rather than assuming the round-1 edit landed correctly. The `/compact` request must carry `previous_summary` from `previousSummaryByCwd`, and the response's `latestSummaryContent` must write back into it.

## 7. Per-project chain state and double-clear

- **`src/replay-resume.ts:509`** — restored chains still collapse to one value across projects. Round 1 added `restoredPreviousSummaries` (per `cwd`); confirm every consumer reads the per-`cwd` map and that the legacy single-value `restoredPreviousSummary` / `droppedPreviousSummary` fields are removed, not merely shadowed.
- **`src/import.ts:276`** — with `provider: "all"`, `ingestSessionList()` runs twice. Hoist the `--restart` clear out of `ingestSessionList` into `importSessions`, or guard it with a per-`(cwd, command)` set for the whole call, so a shared `cwd` is cleared once.

## 8. Unrelated — separate PR

- **`src/cli/pipeline-runner.ts:76`** — a second SIGINT/SIGTERM is discarded, so a hung daemon POST cannot be interrupted. Let the second signal force exit.
- **`docs/architecture.md:113`** — docs describe size + line count + mtime; `fingerprintFile` now persists size + floored mtime. Align the doc (or restore the line count, but the streaming version was removed deliberately).

---

## Tests

- `test/replay-resume.test.ts` — replace summary-id assertions with `outcome`; add: restart on a conversation carrying both hook and replay summaries wipes both and rebuilds `context_items` from `messages` in `seq` order.
- New: fingerprint stability across two consecutive compactions of an unchanged conversation.
- New: `provider: "all"` with a shared `cwd` clears replay state exactly once.
- Keep the round-1 `seenGap` suffix-resume tests unchanged — that rule survives.

## Verification

`npm run typecheck` and `npm test`. Note two pre-existing unrelated failures observed on this branch: `test/daemon/routes/restore.test.ts` and `test/daemon/routes/stats.test.ts` (the latter a 60s `/stats` timeout).

## Docs to update in the same PR

- **PR #302's description** — the "hook-written summaries are untouched" line is now false and must be replaced with the wipe semantics.
- `docs/architecture.md` — replay/restart section, if one exists.
- Help text for `--restart` on both `import` and `compact`: it must say it discards **all** summaries in the conversations the run touched.
