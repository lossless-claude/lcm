# lcm owns compaction under Claude Code mods

Roadmap theme: [What a compaction leaves is lcm's record](../../ROADMAP.md#what-a-compaction-leaves-is-lcms-record).

## What it is

When Claude Code compacts a conversation, the function-hooks module answers the `session.compact` event itself. The conversation the model continues with is then lcm's context for that conversation (its summaries, each carrying the `sum_` id `lcm_expand` follows) followed by the most recent messages, kept as Claude Code holds them. Claude Code's own summarizer does not run.

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
4. **The daemon renders, the module keeps.** The daemon returns the conversation's context window as text: `SummaryStore.readContextWindow`, the reader Codex restore already uses, fitted to a budget. Its items are summaries and the daemon's own unsummarized messages, and both ride in the text; an unsummarized message is never dropped because the engine tail may also hold it (decision 3). The module builds one `user` message from that text and appends the tail from `e.messages`, with handles, starting at a clean boundary: a user message that is not a tool result, so no `tool_use` loses its `tool_result`.
5. **Anything short of a clean answer falls back to `next(e)`.** Claude Code then compacts as it does today. The cases: the daemon is unreachable, busy or over budget; the context is empty; the tail cannot be cut cleanly; or a captured message older than the engine tail is covered by neither a summary nor a rendered item. That last check enforces decision 3. A compaction never fails because lcm could not answer.
6. **`/compact` instructions reach lcm.** `instructions` is passed to the daemon, which can steer the summaries it writes for this compaction.

## Shape

### Module (`hooks/lcm-hooks.ts`)

- `on("session.compact", hook)`: skip `precompute` and any `agentId` with `next(e)`. Otherwise POST `/compact` for the session with `capture_required: true`, `instructions`, and a request for the rendered context; on a clean answer, return `{ messages: [contextMessage, ...tail] }`.
- The tail is the last `freshTailCount` engine messages (default 8, `LCM_FRESH_TAIL_COUNT`), extended backwards to the nearest clean boundary.
- The hook owns the session's pre-compaction, or lcm summarizes twice. `handlePreCompact` (`src/hooks/compact.ts`) does not read the session claim today. If the spike shows PreCompact still fires when a mod answers, it gains the same check the other command hooks make (`functionHooksOwnSession`, fixed by #738 and #739).

### Daemon (`POST /compact`)

- One more response field: the conversation's context window, rendered and fenced as restore renders summaries, with each summary's id in the text.
- It reports which captured messages its summaries cover, so the module can check decision 3 against the tail it keeps.

## Open questions the spike answers first

A throwaway mod that answers `session.compact` with `e.messages` unchanged plus one built marker message, run in a session that loads it, answers:

1. **Does the engine install the answer?** After the compaction, `$.session.messages()` holds the marker, and `tokensAfter` is reported.
2. **Does the classic PreCompact hook still run when a mod answers?** The declarations say core answers `session.compact` when a PreCompact hook blocks, so the two meet. Whether PreCompact runs at all when the chain never reaches core decides whether the session claim alone keeps lcm from summarizing twice.
3. **What budget does the hook get?** `next.budget.ms` on each trigger, against the 120 s lcm allows a PreCompact summary today.
4. **How do engine messages align with captured messages?** `e.messages.length` against the daemon's stored count for the session, and where they diverge (attachments, notices, tool results).
5. **What does a built message accept?** Role, text only, tool blocks, and whether the answer must start with a `user` message.

The design changes if question 1 fails: the module then rewrites `instructions` and `messages` on the way down instead, which steers Claude Code's summary but does not replace it.

## Dependencies

- #738 and #739: the module and the command hooks must agree on who owns a session before the module takes over its compaction.
- The implementing change supersedes the [Context assembly](../architecture.md#context-assembly) statement that nothing in lcm rewrites the harness's message list, and updates it.

## Out of scope for the first cut

- `precompute`: lcm already compacts in the background, so answering ahead of time could make the real compaction instant. It needs the result to stay valid while the conversation grows.
- Subagent transcripts (`agentId`).
- Codex and OMP: neither exposes a seam that replaces its compaction; they keep today's behaviour.

## Privacy

Nothing new is captured. The answer is built from stored summaries, which come from scrubbed content, and from messages the engine already holds.
