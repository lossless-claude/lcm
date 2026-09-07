# Replay ledger redesign — implementation plan

**Spec:** `.xgh/specs/2026-09-07-replay-ledger-redesign-design.md`
**Supersedes:** the ledger implementation in PR #302 (draft)
**Date:** 2026-09-07

## Approach

Rework `copilot/make-replay-resumable` in place rather than starting a new branch — the manifest model, the `seenGap` suffix-resume rule and the SIGINT drain work are sound and should survive. What comes out is the ledger's summary bookkeeping and the `--restart` lineage machinery.

Steps 1–4 are the redesign. Steps 5–7 are ordinary bugs Codex found that are independent of the model; they can land in any order. Step 8 is unrelated hygiene and should be its own PR.

---

## 0. Decisions that shape the steps

**Threading stays** (Pedro, 2026-09-07). `previous_summary` continues to cross sessions, so steps 6–7 are in scope rather than dissolving.

**The anchor rule, formalised.** With threading kept, resume must re-establish the chain in a fresh process. Rather than re-deriving it by query, `replay_ledger` **keeps `summary_id` as a nullable anchor-only column**. Its *purpose* changes: it is no longer what `--restart` deletes (that is now conversation-scoped), only where the chain picks up.

That change alone dissolves `import.ts:440`: a `no_work` row with `summary_id = NULL` is now a complete, valid row — the anchor search simply walks further back to the most recent non-null one.

The anchor's definition matches today's de-facto behaviour, which should be written down rather than reinvented: `getSummariesByConversation` orders `BY created_at`, and the `else if (allSummaries.length > 0)` fallback in `createCompactHandler` (`src/daemon/routes/compact.ts`) takes the last element. So **the anchor is the most recently created summary of that conversation**, regardless of depth.

**Migrations stay additive.** `.github/skills/code-review/SKILL.md` §7 (merged in #310) forbids destructive DDL, so nothing below drops a table or a column.

## 1. Adjust the ledger schema (additive only)

**`src/db/migration.ts`**

- Add the outcome column, guarded for idempotency (check `PRAGMA table_info(replay_ledger)` the way `ensureSummaryDepthColumn` does):
  ```sql
  ALTER TABLE replay_ledger ADD COLUMN outcome TEXT NOT NULL DEFAULT 'compacted';
  ```
- Remove the `CREATE TABLE IF NOT EXISTS replay_ledger_summaries` block and its index so new databases never get it. **Do not `DROP` it** — dev databases that ran round 1 keep a harmless orphan table.
- `prev_session_id` and `model` stay in the schema as nullable columns but stop being written. `summary_id` stays and keeps being written, now as the threading anchor only (see §0).

Resulting row: `(run_id, session_id, position, content_fingerprint, summary_id?, outcome, completed_at)`.

## 2. Add the wipe-and-rebuild helper

**`src/store/summary-store.ts`** — new method, since no wipe path exists today (`grep -rn "DELETE FROM context_items" src/` returns only `replaceContextRangeWithSummary` and the redaction path in `conversation-store.ts`).

```ts
async resetConversationContext(conversationId: number): Promise<number>
```

Pair it with a read-only `countSummaries(conversationId)` so `--restart` can report the total **before** wiping anything (the spec requires the warning to precede the deletion, and the reset method can only return a count after the fact).

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
7. Rebuild — **excluding compaction events**:
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

**Why the exclusion is mandatory:** `CompactionEngine.persistCompactionEvent` (its local `writeEvent` closure, `src/compaction.ts`) calls `createMessage` + `createMessageParts` but **never** `appendContextMessage` — verified, `appendContextMessage` has no callers outside its own definition. So event rows live in `messages` and have never been in `context_items`. A naive `INSERT … SELECT FROM messages` would surface `"LCM compaction leaf pass (normal): 5000 -> 200"` into the model's context, which is a regression the current code does not have. Step 6 makes step 7's predicate redundant, but keep both — step 7 must be correct on its own if step 6 is ever reordered or dropped.

Check the FTS5 mirror: `deleteMessageFromFullText` exists for messages — confirm whether summaries have an equivalent index that also needs clearing, and call it for both the summaries and the deleted event messages.

## 3. Rewrite `clearReplayState`

**`src/replay-resume.ts`**

Delete outright:
- `loadReplaySummaryIds`
- `expandSummaryToMessageIds`
- `restoreContextFromReplaySummaries`
- every `UNION ALL` subquery over `replay_ledger` + `replay_ledger_summaries`

Replace with: resolve the conversations for the run's manifest sessions → `resetConversationContext` on each → delete the run's `replay_ledger` rows. Keep the `missing` / `error` / `ready` distinction from round 1 — it was right, and it is what makes `clearReplayState` return `false` on an unusable database.

Run `countSummaries` over the affected conversations first and print the total, then wipe.

## 4. Record `outcome`; keep `summary_id` as the anchor

**`src/import.ts`, `src/batch-compact.ts`**

`recordReplayProgress` loses `summaryIds` and `prevSessionId`; gains `outcome: "compacted" | "no_work"`; **keeps** `summaryId` (nullable) per §0. The `replayOutcome` gating from round 1 stays — it is the fix for "disabled compactions recorded as done" and is independent of this rework.

**Resume anchor lookup** in `planProject`: from the last done row before the first gap, walk backwards to the most recent row with a non-null `summary_id` and load its content. A run of `no_work` rows is skipped rather than treated as a broken chain — that is what dissolves `import.ts:440`.

**`src/daemon/routes/compact.ts`** — `latestSummaryIds` goes from the response; `latestSummaryContent` and `latestSummaryId` stay (threading needs the content, the ledger needs the id). Keep `replayOutcome`. The `else if (allSummaries.length > 0)` fallback stays and is now the *documented* anchor rule (§0) rather than an accident.

**`src/compaction.ts`** — `createdSummaryIds` on `CompactionResult` is no longer read by replay. Keep it in the compaction-event `metadata` (harmless, useful for debugging); drop it from the route response only.

## 5. Fix the fingerprint predicate (2 findings)

**`src/batch-compact.ts`** — `findUncompacted`'s `source_messages` / `source_tokens` subquery currently uses `role != 'system'`, which over-excludes: `parseTranscript()` accepts `system` and the ingest route persists it.

Use the exact discriminator instead — the compaction event's message part — `CompactionEngine.persistCompactionEvent` writes the row with `role: "system"`, then a part with `partType: "compaction"`:

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

## Known gap, not addressed here

`--restart` runs in the CLI process and wipes summaries while the daemon may be compacting the same conversation. The daemon's `compactingNow` guard is per-request and in-process, so it does not serialise against an external wipe. This is pre-existing to #302 and not introduced by the redesign, but it is the kind of thing Codex raises — either refuse `--restart` while a daemon lock is held, or state explicitly that `--restart` assumes no concurrent compaction. Decide before the review round rather than during it.

## Docs to update in the same PR

- **PR #302's description** — the "hook-written summaries are untouched" line is now false and must be replaced with the wipe semantics.
- `docs/architecture.md` — replay/restart section, if one exists.
- Help text for `--restart` on both `import` and `compact`: it must say it discards **all** summaries in the conversations the run touched.
