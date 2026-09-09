---
"@lossless-claude/lcm": patch
---

`LCM_HOME` moves everything lcm owns — the daemon's port, token and pid, the per-project databases, the events sidecars, the logs — somewhere other than `~/.lossless-claude`. Every path now resolves through `lcmHome()` instead of computing `join(homedir(), ".lossless-claude")` at 49 separate call sites, and the function-hooks module honours the same variable when it reads the daemon's address.

This makes lcm runnable against a scratch directory. Until now the only way to point it elsewhere was to move `HOME`, which takes the host's own configuration with it — so a sandbox for lcm could not be built without breaking the tool under test.
