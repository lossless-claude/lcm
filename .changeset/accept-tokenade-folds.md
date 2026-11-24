---
"@lossless-claude/lcm": patch
---

Accept a Claude Code transcript row that tokenade's cold-resume compaction folded into a placeholder while its stored original still matches: the text around each placeholder must agree in order and each hidden span must be long enough for the tokens it reports, less a bounded share for each redaction inside it. Capture of such a session no longer fails with "transcript prefix differs from stored history" on every ingest.

A folded value never replaces a stored tool call's input, outcome, exit code or block reason, and a rebuild is refused while the transcript holds a folded row and the session is not aligned, since the transcript no longer holds the folded text.
