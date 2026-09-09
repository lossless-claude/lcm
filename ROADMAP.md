# Roadmap — @lossless-claude/lcm

The strategic source of truth for this project: the durable themes work is judged
against. Released versions are recorded in [CHANGELOG.md](./CHANGELOG.md); execution
state lives in GitHub issues. This file is neither — **it is not a queue**, and an entry
is not done when an issue closes.

A theme states what must become true and how we would know. Work derives from it: an
issue that fits no theme is either out of scope or evidence a theme is missing. Large
features are admitted here first, as a theme or an amendment to one, before any issue
is opened.

## Themes

### Retrieval quality is measured on real corpora, not synthetic gates

What search returns is what lcm is worth. The synthetic recall gate reports 93% where a
reviewed real corpus scores 54% (#358), so the gate cannot be the evidence a change is
good. Every retrieval claim carries a measurement against transcripts someone actually
wrote.

### The record matches what happened

Capture, attribution and structure are separate properties, and a gap in one is not a
gap in the others (see [CONTEXT.md](./CONTEXT.md)). Sessions must be attributable to
whoever dispatched them (#419), what a session did must be filterable and not only
greppable (#421), and no session may end without a durable record (#344).

### One project, one memory

A project's memory is a property of the project, not of the directory it was checked
out into (#399), and every location lcm owns derives from one injected root rather than
the ambient environment (#409).

### Recall becomes enforcement

Remembering a decision is weaker than making it structurally hard to violate. Critical
memory should be promoted into contracts, checks and tests that bind future work
(#198), rather than surfaced as prose an agent may ignore.

### Parity across hosts and protocols

lcm is a memory layer, not a Claude Code plugin. It holds the same guarantees under
Codex and under Claude Code, across command hooks and function hooks, and tracks the
MCP protocol it speaks (#401).

## Privacy

Memory is captured passively, so redaction and sensitivity classification are part of
capture, not a feature layered on top. Any theme above that widens what is captured
must say what it does about sensitive content before it ships.
