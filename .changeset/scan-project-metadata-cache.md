---
"@lossless-claude/lcm": patch
---

Cache unchanged transcript-scan project records, remember missing metadata until
the project directory changes, and yield on an elapsed time budget. Doctor now
reports counts of project directories without metadata and with missing working
directories without changing their stores.
