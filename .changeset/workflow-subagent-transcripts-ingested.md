---
"@lossless-claude/lcm": patch
---

fix: workflow subagent transcripts are now discovered and imported

Subagent transcripts dispatched inside a workflow run live one directory deeper,
under `subagents/workflows/<run>/`, and discovery only ever looked at files
directly inside `subagents/`, so an entire class of subagent conversations was
silently skipped. Discovery now walks into subdirectories of `subagents/` to
find them, reading the same `.meta.json` sidecar attribution as a flat subagent
transcript. Each workflow run also writes its own `journal.jsonl`, which is not
a transcript and stays excluded by name.
