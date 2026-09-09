---
"@lossless-claude/lcm": patch
---

`LCM_HOME` now reaches every path lcm resolves. Three sites spelled the root through an aliased import (`hd()`, `deps.homedir`, `_homedir2()`) and kept pointing at `~/.lossless-claude` regardless of the variable: purging all projects, one of the session-snapshot config reads, and `lcm doctor`, which now takes the lcm home as an injected dependency like it already took the user's home.

Adds `LcmPaths`, one object holding every location derived from a single root, and a test that fails when the root is named outside the factory.
