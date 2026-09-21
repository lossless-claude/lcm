---
"@lossless-claude/lcm": patch
---

chore: the bench temp-directory cleanup test no longer reads another run's directory

`lcm bench` copied conversation text into `mkdtemp(join(tmpdir(), "lcm-bench-rg-"))`, a name no
process owns. The regression test that asserts the directory is removed on every path — including a
failure to acquire the database connection — identified its own directory by diffing `lcm-bench-rg-*`
entries in the shared temp root, so under two concurrent suite runs the first new entry could be
another run's live directory and the assertion read as a leak (issue #537).

The directory is now created under `lcm-bench-rg-<pid>-`, and the test matches that process-scoped
prefix. The assertion itself is unchanged: the created directory is still captured rather than
counted, so a run that never created one fails.

Test infrastructure only: nothing about the emitted CLI or the daemon changes.