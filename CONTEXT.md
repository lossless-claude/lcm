# lcm

Durable cross-session memory for coding agents. lcm reads the transcripts an agent
harness writes to disk and turns them into a searchable, compacted record.

## Language

### What lcm does to a transcript

**Capture**:
A transcript's content reaching lcm's database at all.
_Avoid_: ingestion, collection

**Attribution**:
Knowing which session a captured message belongs to, and which session dispatched it.
Independent of capture — content can be captured and still be unattributed.
_Avoid_: linking, correlation

**Structure**:
The same captured content held as a queryable field rather than as text inside a
message. Structure is what a filter can select on; message text is what only full-text
search can reach.
_Avoid_: typing, parsing, normalisation

### What a transcript holds

**Session**:
One conversation between a person and the agent, written as one transcript file.

**Subagent session**:
A session a parent session dispatched. The harness writes it as its own transcript
file, so it is a session in every respect except that nobody started it directly.
_Avoid_: sidechain, agent session

**Parent session**:
The session that dispatched a subagent session.
_Avoid_: caller, origin session

**Skill expansion**:
The text a skill injects into the model's context when it is invoked. It arrives in
the transcript as ordinary message text, not as a tool call.
_Avoid_: skill prompt, skill body

### What lcm keeps

**Episodic memory**:
The captured messages and the summaries compacted from them, in the order they happened.
_Avoid_: history, transcript store

**Promoted memory**:
A statement kept on its own, apart from any session: stored by an agent through
`lcm store` / `lcm_store`, or promoted from passive capture. Search reports the two
layers separately.
_Avoid_: semantic memory, knowledge base

**Tag**:
A `<prefix>:<value>` label on a promoted memory, the only thing a filter selects on.
`docs/tag-schema.md` lists the prefixes.
_Avoid_: category, label
