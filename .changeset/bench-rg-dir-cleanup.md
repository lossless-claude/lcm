---
"@lossless-claude/lcm": patch
---

fix: `bench run` cleans up its temporary ripgrep directory and reports the original error

A failure while acquiring the database connection left the `lcm-bench-rg-*`
directory behind. Its creation moved inside the cleanup scope, so the directory
is removed on every path. Connection and scoring failures now return
`exitCode: 1` with the error text on stdout instead of propagating, and a
rejection from the cleanup itself no longer replaces that error.
