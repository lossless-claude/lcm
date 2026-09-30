---
"@lossless-claude/lcm": minor
---

Allow `lcm eval summarizer --models session-pool` to compare dedicated summarize workers with named endpoints through the authenticated daemon. Evaluation keeps the project database read-only, reports usage under the answering worker's model, and fails an unavailable pool without fallback while other candidates continue.
