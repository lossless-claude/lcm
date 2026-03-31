---
"lossless-claude": patch
---

Add prompt-time memory injection budget and deduplication (#215)

Recalled memories are now deduplicated and capped to a configurable byte
budget before being injected into the prompt. Surfacing is only logged for
memories that actually appear in the final output.
