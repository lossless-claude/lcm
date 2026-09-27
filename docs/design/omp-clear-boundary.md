# An OMP `/clear` starts a new conversation

**Status:** proposed, awaiting the product decision below. Refs #540. Interacts with #539.

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

- `parseOmpTranscriptRecord` (`src/omp-transcript.ts`) returns `{}` for every non-message entry, `reset_boundary` included. `test/omp-transcript.test.ts` ("stores nothing for entries that carry no memory") pins this down. The boundary leaves no trace.
- `readOmpTranscriptDelta` (`src/omp-transcript-reader.ts`) is the shared byte-cursor reader (`src/jsonl-transcript-reader.ts`) running with the OMP format. It returns one flat list of messages.
- `SessionCapture.captureTranscript` / `write` (`src/capture.ts`) resolve the conversation through `ConversationStore.getOrCreateConversation(sessionId)`. The conversation identity is the OMP session id and nothing else. Both sides of a clear land in one conversation, with consecutive `seq` values.
- The cursor (`src/db/transcript-cursor.ts`, one row per conversation) is trusted only while `messageCount` equals the conversation's stored count (`ompSource.read`, `src/transcript-source.ts`). When it cannot resume, the reader scans the whole file, and `validateTranscriptRecovery` requires the re-parsed prefix to match the stored messages. A shorter or different prefix throws `TranscriptSourceError` on every later capture.

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

- **No fingerprint bump.** Bumping `OMP_FINGERPRINT_VERSION` invalidates every OMP cursor. The full rescan that follows would compare segment 0 against a conversation that already stores both sides, and fail with "shorter than stored history". Existing cursors keep resuming, a boundary already inside stored content is not split retroactively, and boundaries appended after the upgrade are honoured. Conversations that are already mixed stay mixed.
- **Recovery rule for full rescans that still happen** (a new inode after OMP rewrites a file, or a cursor mismatch): map each segment to the row that carries its boundary entry id. A boundary with no row splits only if it lies at or after the end of the preceding row's stored messages. Otherwise it predates boundary support and is ignored. *Design, untested.*
- The cursor is saved against the newest segment's row, and its `messageCount` counts that segment's messages only. It is still written in the same transaction as the messages.

Code size: parser (one new record kind), the shared reader surfacing boundary positions, capture writing segments in one transaction, one column and its migration, and tests. Restore and the live `/compact` path are unchanged.

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

## Interaction with #539 (OMP tree and rewind)

#539 changes capture to follow the `parentId` chain from the final leaf instead of reading in file order. Whichever of #539 and #540 lands second rebases the parser change.

- The boundary's `parentId` is the leaf at the moment of the clear, so a walk from any post-clear leaf passes through it. The boundary is on the live path whenever the leaf is after it.
- Segmentation must be computed on whatever sequence the reader yields: file order today, the live path after #539. Keeping #540's parser change to one new record kind (`reset_boundary` → `{ boundary: { entryId } }`) makes the two changes rebase onto each other trivially.
- Both changes alter which records produce what. The cursor constraint above holds for both: at most one fingerprint bump across the two, and #540's slice makes none.
- *Unconfirmed:* whether OMP's `/tree` can move the leaf to an entry before a boundary. If it can, the boundary leaves the live path and OMP shows the pre-clear turns again. Under A, the next messages would then belong to the earlier segment. Out of scope for the first slice.

## First PR slice (option A)

1. `src/omp-transcript.ts`: `reset_boundary` → `{ boundary: { entryId } }`. The existing "stores nothing" test moves this entry to a test of its own.
2. `src/jsonl-transcript-reader.ts`: an optional boundary field on the format's parsed record. The delta reports each boundary's position in its message list. Codex is unaffected.
3. Schema: the nullable boundary column on `conversations`, with its migration.
4. `src/capture.ts` and the OMP adapter: write each segment to its own row in one transaction, create the row for a boundary with no messages after it, save the cursor against the newest row, and apply the recovery rule.
5. Tests:
   - a live delta crossing a boundary;
   - a boundary as the last record;
   - re-capture of the same file (idempotent);
   - a full rescan with segment rows present;
   - a legacy mixed conversation (not split, no error);
   - restore after a clear returning no pre-clear turns.
6. Docs: `docs/omp.md` (session identity, remaining gap 5), `docs/architecture.md` (capture), and a changeset.

No hook change and no fingerprint bump. Second slice: closed-segment compaction by conversation id.
