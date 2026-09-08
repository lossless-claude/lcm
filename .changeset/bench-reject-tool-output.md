---
"@lossless-claude/lcm": patch
---

Stop `lcm bench build` from sampling pasted tool output as a question source. A `role='user'` message often carries a grep listing, a `git push` transcript, or a directory listing rather than a human turn, and those read as highly distinctive — unique paths and hashes — so sampling favoured them: 55% of one 60-question set. A question generated from a listing asks about the listing, not about anything a person wanted to recall, and it is usually answerable from several sessions, which a single-label score counts as a miss.
