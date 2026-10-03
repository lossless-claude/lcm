# lcm owns compaction under Claude Code mods

Roadmap theme: [What a compaction leaves is lcm's record](../../ROADMAP.md#what-a-compaction-leaves-is-lcms-record).

## What it is

This installation design is future work. The current opt-in
[shadow hook](compaction-shadow.md#shadow-hook) records alternative documents
beside native and returns native unchanged.

Under the installation design, when Claude Code compacts a conversation, the function-hooks module answers the `session.compact` event itself. The conversation the model continues with is then lcm's context for that conversation (its summaries, each carrying the `sum_` id `lcm_expand` follows) followed by the most recent messages, kept as Claude Code holds them. Claude Code's own summarizer does not run.

Today the PreCompact command hook prints lcm's summary and Claude Code still writes its own, and that summary replaces the conversation. The model reads the host's summary; lcm's DAG sits beside it and is reached only by searching. `session.compact` is the seam that lets lcm's record become the conversation.

## What the host offers

From the mods reference ([events](https://code.claude.com/docs/en/plugins/mods/reference#events)) and the declarations Claude Code 2.1.285 writes for mods (`SessionCompactInput`, `SessionCompactResult`, `SessionMessage`):

- `session.compact` fires before every compaction. `trigger` is `manual` (`/compact`), `auto` (the threshold, or a prompt too long), `plugin` (`$.session.compact`) or `precompute` (computed ahead and kept for the compaction that comes, if the conversation it ran over still leads).
- The input carries `instructions` (the text after `/compact`) and `messages`, the transcript being compacted, each stamped with an opaque `handle`. A subagent's own transcript fires it with `agentId`.
- A hook can rewrite `instructions` or `messages` on the way down, rewrite the result on the way up, answer `{ messages }` of its own without calling `next`, or veto with `{ skip }`.
- In an answer, a message that keeps its `handle` stands as the engine has it; one without a handle is built from `role`, `text` and tool blocks. There is no summary string: the summary is a message.
- A hook's own run time is capped at 10 s, but time spent inside `next` or a mods API call (`$.http.fetch` included) does not count.
- `turn.step` cannot change the messages a request carries (they are pinned), so compaction is the only point where a plugin decides what the model reads.

## Decisions

1. **The module answers `manual`, `auto` and `plugin` for the main conversation.** It does not call `next`, so Claude Code's summarizer does not run. `precompute` and `agentId` are later steps (see [Out of scope](#out-of-scope-for-the-first-cut)).
2. **Capture first, as today.** The answer is built only from a conversation whose transcript the daemon has captured up to the compaction; a failed or unverified Capture means no answer.
3. **No gap, duplication allowed.** Every message the engine drops is covered by a summary in the answer or kept in the tail. A message both summarized and kept costs tokens; a message in neither is lost to the model. When the two cannot be aligned, keep more, never less.
4. **The daemon renders, the module keeps.** The daemon returns the conversation's context window as text: `SummaryStore.readContextWindow`, the reader Codex restore already uses, checked against a strict byte budget. The complete window is rejected when it exceeds that budget; restore's fit-by-dropping rule never applies. Its items are summaries and the daemon's own unsummarized messages, and both ride in the text; an unsummarized message is never dropped because the engine tail may also hold it (decision 3). The module builds one `user` message from that text and appends the tail from `e.messages`, with handles, starting at a clean boundary: a user message that is not a tool result, so no `tool_use` loses its `tool_result`.
5. **Anything short of a clean answer falls back to `next(e)`.** Claude Code then compacts as it does today. The cases: the daemon is unreachable, busy or over budget; the context is empty; the tail cannot be cut cleanly; or a captured message older than the engine tail is covered by neither a summary nor a rendered item. That last check enforces decision 3. A compaction never fails because lcm could not answer.
6. **`/compact` instructions reach lcm.** `instructions` is passed to the daemon, which can steer the summaries it writes for this compaction.

## Shape

### Module (`hooks/lcm-hooks.ts`)

- `on("session.compact", hook)`: skip `precompute` and any `agentId` with `next(e)`. Otherwise POST `/compact` for the session with `capture_required: true`, `instructions`, a UUID capture boundary, and a strict rendered-context budget; on a clean answer, return `{ messages: [contextMessage, ...tail] }`.
- The tail is the last `freshTailCount` engine messages (default 8, `LCM_FRESH_TAIL_COUNT`), extended backwards to the nearest clean boundary.
- When the hook answers, the PreCompact command hook does not run, so the hook does the Capture and summarization PreCompact did. When it falls back with `next(e)`, PreCompact runs as today. A fallback after the hook's own `/compact` must leave PreCompact's request no work to repeat; the implementation tests that.

Leaf and condensed summaries default to the configured pipeline (`pool`), preserving
its cost profile. A later PR adds a separate working-state header with Sonnet as its
default; presenting that header does not regenerate stored history.

### Daemon (`POST /compact`)

- One response field, `contextWindow`, on every rendered request: the complete conversation window, rendered and fenced with each summary's id, or a typed non-ready outcome. A window over the byte budget is rejected, never trimmed or truncated.
- Capture is verified through the UUID boundary before the real summary sweep. `compaction_summary_model` defaults to `pool`, preserving the configured pipeline; `haiku`, `sonnet` and `session` opt into requester jobs. Sonnet writes every node only when explicitly selected.
- Replies distinguish exclusions, missing summarizer, provider failure, deadline and a bounded boundary-scan failure; deadlines have their own warning/observation code.
- It reports which captured messages its summaries cover, so the module can check decision 3 against the tail it keeps.

## How Claude Code 2.1.287 handles an answer

Established for a manual `/compact` answered with one built message followed by engine messages kept with their handles:

1. **The engine installs the answer.** The conversation after the compaction is the answer, and the context's token count reflects it.
2. **The PreCompact command hook does not run when a mod answers.** The other command hooks run as usual.
3. **The hook's own budget is 10 s** on a manual compaction (`next.budget.ms`). The reference excludes time spent inside mods API calls, so a daemon round trip through `$.http.fetch` should not count against it; that is not yet measured.
4. **A built `user` message may come first, even before a kept `user` message.** Text-only built messages are confirmed; tool blocks are not.
5. **Engine messages are not turns.** An assistant reply can arrive as several messages, one per content block, including one with no text. `e.messages` carries handles; `$.session.messages()` does not, and it returns the transcript, not the compacted context.

## Open question

How the module's tail lines up with the daemon's captured messages, so decision 3 can be checked. Counting is unsafe (point 5); the implementation needs a key both sides hold, or it keeps more, as decision 3 allows.

## Dependencies

- #738 and #739: the module and the command hooks must agree on who owns a session before the module takes over its compaction. Compaction itself does not double (point 2 above), but restore and capture around it do until those land.
- The implementing change supersedes the [Context assembly](../architecture.md#context-assembly) statement that nothing in lcm rewrites the harness's message list, and updates it.

## Out of scope for the first cut

- `precompute`: lcm already compacts in the background, so answering ahead of time could make the real compaction instant. It needs the result to stay valid while the conversation grows.
- Subagent transcripts (`agentId`).
- Codex and OMP: neither exposes a seam that replaces its compaction; they keep today's behaviour.

## Privacy

Nothing new is captured. The answer is built from stored summaries, which come from scrubbed content, and from messages the engine already holds.
