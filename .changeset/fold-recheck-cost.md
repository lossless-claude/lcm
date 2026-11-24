---
"@lossless-claude/lcm": patch
---

Make the re-check after a tokenade fold cheap. A fold rewrites a Claude Code transcript through a rename, so lcm reads it in full again and compares the stored history with it; that compare no longer holds the daemon for seconds. It yields every 10 ms, scrubs only the side that needs it, skips the rows of transcript chunks whose bytes are unchanged since they were stored (hashes saved with the cursor in a new `claude_transcript_chunks` table, used only while the stored rows are unchanged), and matches a folded row against its stored original before scrubbing that original. The transcript scan skips a transcript rewritten at the same size, and `lcm import --rebuild` classifies an aligned folded session without its full alignment pass. On real sessions of 43 MB and 74 MB the re-check dropped from 5.0 s and 14.8 s to under 1.3 s, with the longest event-loop block under 50 ms.
