---
"@lossless-claude/lcm": patch
---

chore: the stores are the only readers and writers of Episodic and Promoted memory's tables

`ConversationStore` and `SummaryStore` expose the operations Episodic memory
is asked for — find a session's conversation, append a delta, read the context
window, replace a range with a summary — and the daemon routes, the importer
and the capture module go through them instead of preparing their own
statements; a test pins that. Methods only tests called are removed.
`PromotedStore` is the one reader of `signal:memory_vote` rows, so how a vote
is encoded in its tags is decided in one place. `/recent` answers summary
records in the store's shape (`summaryId`, `tokenCount`, `createdAt`, …).
