---
"@lossless-claude/lcm": patch
---

`POST /compact` no longer answers 500 when a compaction leaves the context larger than it found it. The completion banner's savings bar clamps to its width instead of throwing on a negative repeat count, and reports "grew" with an honest percentage and token delta instead of a false "saved"/"compression" figure.
