---
"@lossless-claude/lcm": minor
---

An Oh My Pi `/clear` now starts a new stored conversation under the same session id. The turns before the clear stay stored and searchable in their own conversation, and a restore after the clear returns only what followed it, or answers as for a fresh session start when nothing has been said since. Live capture, `lcm import` and archived `.jsonl.gz` sessions all split at a clear the same way. Conversations stored by earlier versions are not split. The conversation a clear closes is not compacted afterwards, and compaction sweeps no longer select it. Project databases gain a nullable `conversations.opened_by_entry_id` column the first time they are opened.
