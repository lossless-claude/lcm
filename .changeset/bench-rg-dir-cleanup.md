---
"@lossless-claude/lcm": patch
---

fix: `bench run` cleans up its temporary ripgrep directory and reports the original error

A failure while acquiring the database connection left the `lcm-bench-rg-*`
directory behind. Connection acquisition and scoring moved inside the `try`
whose `finally` removes that directory, so it is cleaned up on every path.
Those failures now return `exitCode: 1` with the error text on stdout instead
of propagating, and a rejection from the cleanup itself no longer replaces
that error.
