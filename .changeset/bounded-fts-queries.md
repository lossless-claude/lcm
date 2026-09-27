---
"@lossless-claude/lcm": patch
---

A full-text query now keeps at most its first 32 terms and drops terms longer than 64 characters, and a project-scoped search of promoted memory runs its full-text match once instead of once per promoted row of the project. Promotion dedup searches with a whole summary and prompt search with a whole prompt, and either could keep the daemon from answering anything for minutes. When the daemon cannot take its port because an lcm daemon that does not answer holds it, `lcm daemon start` now says so, with that daemon's pid, instead of reporting a process that is "not an lcm daemon".
