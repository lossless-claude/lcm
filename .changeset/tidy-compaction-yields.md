---
"@lossless-claude/lcm": patch
---

Keep large compactions responsive with bounded database and source-preparation batches, incremental context token totals, and cached message schema checks and lookups. Preserve summary text, links and stored token accounting, including messages captured during model waits. Thread the left half's completed summary into the right half when recovering from cut answers.
