# An OMP `/clear` starts a new conversation

**Status:** proposed, awaiting the product decision below. Refs #540. Builds on #539.

## The decision

Should memory that an OMP `/clear` hid from the model:

- **(A)** stay searchable, under a conversation of its own, while the post-clear turns start a new conversation;
- **(B)** stay in one conversation, behind a stored marker that restore, compaction and summaries must honour; or
- **(C)** be dropped?

Recommendation: **A**. It is what lcm already does for Claude Code's `/clear`, so it is parity, not a new policy.

## What OMP does on `/clear`

Confirmed in OMP 18.2.8 source:

- `/clear` runs `AgentSession.resetSessionContext()` (`src/session/agent-session.ts`). It drops the in-memory conversation and appends one entry through `SessionManager.appendResetBoundary()` (`src/session/session-manager.ts`). The session id, title and session file are unchanged.
- The entry is `{ type: "reset_boundary", id, parentId, timestamp }` with no payload (`ResetBoundaryEntry`, `src/session/session-entries.ts`). `parentId` is the leaf at the moment of the clear (`#freshEntryFields()`), and every later entry chains through the boundary.
- OMP's model-context rebuild (`buildSessionContext`, `src/session/session-context.ts`) emits only entries after the latest boundary on the path, so a resume, reload or `/shake` does not bring back the cleared turns. The full-history export ignores the boundary, and the file keeps everything.
- `resetSessionContext` emits no hook or extension event. `session_switch` fires only for `new`, `resume` and `fork`. **The only way lcm can see a clear is the boundary entry in the file.**

## What lcm does today

### Capture

- `parseOmpTranscriptRecord` (`src/omp-transcript.ts`) returns only the tree node (`id`, `parentId`) for every non-message entry that carries an id, `reset_boundary` included. `test/omp-transcript.test.ts` ("stores nothing for entries that carry no memory") pins down that such entries yield no message. The boundary stays a link in the `parentId` chain and marks nothing.
- `readOmpTranscriptDelta` (`src/omp-transcript-reader.ts`) is the shared byte-cursor reader (`src/jsonl-transcript-reader.ts`) running with the OMP format. Its `selectMessages` is `selectOmpLiveMessages`: a delta keeps the messages on the live path, the `parentId` chain from the last entry among the records it read (`ompLivePath`). It returns one flat list of those messages, plus the records it read.
- `SessionCapture.captureTranscript` / `write` (`src/capture.ts`) resolve the conversation through `ConversationStore.getOrCreateConversation(sessionId)`. The conversation identity is the OMP session id and nothing else. Both sides of a clear land in one conversation, with consecutive `seq` values.
- The cursor (`src/db/transcript-cursor.ts`, one row per conversation) carries `messageCount`, the total messages consumed through its byte offset (`JsonlTranscriptCursor`, `src/jsonl-transcript-reader.ts`). It is trusted only while that count equals the conversation's stored count (`ompSource.read`, `src/transcript-source.ts`). When it cannot resume, the reader scans the whole file and `ompMessagesAfterStored` reconciles the file's live path with the stored messages: stored history that is a prefix of the live path continues it; otherwise the earliest in-order match of stored history ends at the entry holding its last stored message, and the live-path messages after that entry are the delta. Stored history the file does not hold in order throws `TranscriptSourceError` on every later capture.

`conversations.session_id` is **not unique** (`src/db/migration.ts`). `getConversationBySessionId` returns the newest row for a session id (`ORDER BY created_at DESC, conversation_id DESC`). The schema already allows several conversations per session id. Nothing creates them today.

### Restore

The OMP hook (`hooks/omp/lcm.ts`, `session_start`) awaits `/ingest`, then posts `/restore` with `source: "startup"`. For OMP, `/restore` goes through `codexOutcome` → `readCodexContext` (`src/daemon/restore/`), which returns the last summaries and user/assistant messages of the session's conversation (`SummaryStore.readContextWindow`).

Because `/clear` fires no hook, restore never runs at the moment of the clear. It runs when OMP next starts on that session (resume). By then the stored conversation holds both sides, so the recent-context window can hand back the cleared turns. OMP itself does not show those turns to the model after a resume. **This is the user-visible bug.**

### Search and summaries

- Episodic search hits carry the conversation's session id (`RankedHistoryHit`, `src/search/native-history.ts`). A cleared turn and a post-clear turn are indistinguishable.
- Compaction (`CompactionEngine`, `src/compaction.ts`) chunks one conversation's context items in order. A leaf summary can span the clear, and condensed summaries fold both sides together.
- Prompt-time search (`/prompt-search`) reads promoted memory only, so conversation identity does not affect it.

### `session_ingest_log`

The OMP hook never calls `/session-end` or `/session-complete`, and `import` does not either. So no OMP session ever gets a `session_ingest_log` row. Even if one existed, OMP's adapter sets `mayRecoverTail: true`. That makes `/ingest` skip the completeness shortcut (`src/daemon/routes/ingest.ts`), and `lcm import` checks the log for Claude sessions only (`src/import.ts`). For OMP, "already ingested" means the per-conversation stored count plus the byte cursor. The log is not involved, so the issue's third bullet does not change behaviour.

## The other harnesses

- **Claude Code**: `/clear` opens a new transcript file under a new session id and fires `SessionStart` with `source: "clear"`. *Not verified from lcm's code:* the new session id comes from the issue text and `docs/hook-protocol.md`. lcm treats that source as a fresh start (`isExplicitNonCompact`, `src/daemon/restore/index.ts`). The new session has no conversation yet, so restore returns promoted memory and no episodic context. The cleared session stays whole, compacted and searchable as its own conversation. **This is option A.**
- **Codex**: lcm's Codex hook passes `SessionStart` `source` through (`src/hooks/codex.ts`), and `docs/codex-parity.md` lists `clear` among the sources it handles. `readCodexContext` falls back to another conversation only for `startup`. *Unconfirmed:* neither lcm's code nor its docs establish whether a Codex clear writes a new rollout file under a new id or continues the same one. If it continues the same one, Codex has the same defect.

## Options

### A: a new conversation at each boundary

Each `reset_boundary` closes the current conversation. The next messages go to a new `conversations` row with the **same `session_id`** and a new nullable column recording the boundary entry id that opened it (name to be settled, e.g. `opened_by_entry_id`; `NULL` for the first segment).

The session id stays unchanged because it keys tool events, promoted memory's session affinity, `session_compactions`, the compaction in-flight guard, replay state and the sweep. Encoding the boundary into it would break all of these.

What the user sees:

- **Restore:** `getConversationBySessionId` already returns the newest row, the current segment, so restore needs no change. If nothing has been said since the clear, the current segment is empty. `readCodexContext` then takes the `startup` fallback to `latestActiveConversation(excludingSessionId)`. That excludes every segment of this session, so the result looks like a fresh session start: another session's context under `recent-project-context`, never the cleared turns. Capture must therefore create the new segment's row even when the boundary is the last record. Writing an empty delta to the current row, as capture does today, is not enough.
- **Search:** cleared turns stay findable. Their hits carry the same session id, but they belong to a different conversation from the post-clear turns.
- **Summaries:** each segment is compacted on its own, so no summary spans a clear.

Migration and idempotency:

- **No fingerprint bump.** The cursor format does not change, so existing OMP cursors keep resuming. Bumping `OMP_FINGERPRINT_VERSION` would only force every OMP file through a full re-read. A boundary already inside stored content is never split retroactively; boundaries appended after the upgrade are honoured. Conversations that are already mixed stay mixed.
- **Recovery rule for full rescans that still happen** (a new inode after OMP rewrites a file, or a cursor mismatch): `ompMessagesAfterStored` reconciles the whole session's stored messages with the file, as today. Only the records after the entry holding the last stored message are segmented, by the rule under "Segmentation on the live path". A live boundary there opens a row unless a row already carries its entry id (a boundary that was the last record when it was captured). A boundary before that point is never re-split: it already has its row, or it predates boundary support. *Design, untested.*
- **The cursor count stays cumulative.** `messageCount` keeps its contract, the total messages consumed through the offset, counted across every segment of the session. The per-segment position is derived at write time from the target row's own stored count, never from the cursor. The cursor is saved against the newest segment's row, in the same transaction as the messages, and only that row's cursor is loaded, because `getConversationBySessionId` returns the newest row. Each site that compares the count stays correct because the transcript read sees the session's stored total instead of the newest row's count:
  - `readJsonlTranscriptDelta` advances the count by the scanned suffix, and `canResume` checks only that it is a non-negative integer. Unchanged: a boundary is not a message, so the count the reader adds is the same.
  - `ompSource.read` trusts the cursor only while `cursor.messageCount === stored.storedCount`, passes `prior.messageCount` as `sourceOffset` on a resume, and rebuilds the checkpoint after a rescan as `stored.storedCount + messages.length`. `readOmpArchive` passes `stored.storedCount` as `sourceOffset`. `StoredTranscript.storedCount` becomes the sum of the stored counts of every conversation row with the session id. A Codex session has one row, so its value is unchanged.
  - `ompMessagesAfterStored` checks that `storedMessages()` returns `storedCount` messages and matches them against the live path. `storedMessages()` returns every segment's messages, oldest row first, each in `seq` order. A boundary carries no message, so this is exactly the live-path messages already consumed, and the prefix and in-order matches hold unchanged.
  - `SessionCapture.write` (`src/capture.ts`) skips the first `storedCount - sourceOffset` messages of the delta, with `storedCount` the same session total the source compared. Each remaining message goes to its segment's row, with `seq` equal to that row's stored count plus its index among the row's new messages.

Code size: parser (one new record kind), the live-path selection surfacing boundary positions, capture writing segments in one transaction, one column and its migration, and tests. Restore and the live `/compact` path are unchanged.

Known gap: `/compact` and the catch-up sweep resolve a conversation by session id, so they always reach the newest segment. A closed segment is compacted after the clear only if it was already compacted before it. Its raw messages stay searchable. `UncompactedConversation` (`src/batch-compact.ts`) already carries `conversationId`. Letting the sweep pass it and `/compact` accept it closes the gap (second slice).

### B: one conversation with a stored boundary marker

The boundary is stored in the conversation, as a `system` message row or as a `conversations` column holding the latest boundary's `seq`. Every reader must honour it.

What the user sees: the same as A for restore and summaries, provided every reader honours the marker. Search is the same as today.

Cost: the marker is knowledge every consumer must remember:

- `readContextWindow` must start after it;
- leaf-chunk selection and condensed passes in `compaction.ts` must not cross it;
- expansion and description must show it;
- any future reader of a conversation must learn it.

Each missed consumer leaks cleared history back. It meets the same cursor constraint as A: no retroactive split without breaking recovery. A marker stored as a message row also changes stored counts. It is larger and riskier than A and spread across the compaction engine.

### C: drop pre-boundary content

Live capture stores the pre-clear turns at `agent_end`, before the user types `/clear`. Honouring C on the live path therefore means deleting stored messages, context items, summaries and full-text rows when the boundary arrives. It could skip them only at import time. That deletion is the concrete reason to reject C, on top of contradicting the lossless premise. Rejected.

## Segmentation on the live path (#539)

Capture follows the `parentId` chain from the last entry, not file order (#539). A later entry in the file can sit on a branch that does not descend from a boundary, so file position never decides a segment. Segmentation works on the records a read selects: a resumed delta, or the records after stored history in a full rescan.

- A boundary opens a segment only if it is on the live path, an ancestor of the last entry (`ompLivePath`). A boundary on an abandoned branch opens nothing, like the messages beside it.
- A selected message belongs to the segment opened by the nearest boundary among its live-path ancestors in those records. With no such boundary, it belongs to the newest stored row, the current segment.
- A clear keeps its boundary on the live path: the boundary's `parentId` is the leaf at the moment of the clear, and every later entry chains through it until the leaf moves.
- **A rewind to before a boundary** takes that boundary off the live path, and OMP shows the pre-clear turns again. If the boundary is in the same read, it opens nothing and its descendants are not selected. If it is already stored, its row stays and is not reopened, rewritten or merged back: stored rows only grow, as stored history does on any rewind today (`selectOmpLiveMessages` does not revisit history stored before a delta). lcm stores no OMP entry ids, so a delta cannot find the segment of an ancestor stored before it. The messages after the rewind have no boundary among the read's live-path ancestors, so they go to the current segment. Restore after such a rewind can therefore return abandoned post-clear turns, the limitation any rewind already has. *Unconfirmed:* whether OMP's `/tree` can move the leaf to an entry before a boundary; the rule holds either way.
- A whole-file read whose chain breaks at an entry the file does not hold keeps every record in file order (`ompLivePath` returns no path). Segmentation then follows file order too: every boundary opens a segment.
- #539 made no fingerprint bump (`OMP_FINGERPRINT_VERSION` is still `omp-transcript-prefix-v1`), and #540's slice makes none.

## First PR slice (option A)

1. `src/omp-transcript.ts`: `reset_boundary` keeps its tree node and adds `boundary: { entryId }`. The live-path selection reports each live boundary's position among the messages it returns. The existing "stores nothing" test moves this entry to a test of its own.
2. `src/jsonl-transcript-reader.ts`: unchanged apart from carrying the OMP selection's boundary positions on the delta. The OMP adapter computes segments from the records it already returns. Codex is unaffected.
3. Schema: the nullable boundary column on `conversations`, with its migration.
4. `src/capture.ts` and the OMP adapter: give the transcript read the session's stored total and every segment's stored messages, write each segment to its own row in one transaction, create the row for a boundary with no messages after it, save the cursor against the newest row with its cumulative count, and apply the recovery rule.
5. Tests:
   - a live delta crossing a boundary;
   - a boundary as the last record;
   - re-capture of the same file (idempotent);
   - a full rescan with segment rows present;
   - a legacy mixed conversation (not split, no error);
   - a boundary on an abandoned branch (no segment);
   - a rewind to before a stored boundary (no row reopened, later messages in the current segment);
   - restore after a clear returning no pre-clear turns.
6. Docs: `docs/omp.md` (session identity, remaining gap 5), `docs/architecture.md` (capture), and a changeset.

No hook change and no fingerprint bump. Second slice: closed-segment compaction by conversation id.
