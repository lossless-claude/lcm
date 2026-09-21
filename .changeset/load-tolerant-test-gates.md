---
"@lossless-claude/lcm": patch
---

chore: the tests that failed only under CPU load no longer report a regression

Three tests failed only when the suite ran on a busy machine (issue #526):

- The recall gate combined four assertions — recall@5, beating the grep baseline, the empty-result
  rate and query latency — in one test body with a 15 s vitest timeout. Under load that body
  outlived the timeout, so the run reported a wall-clock failure that reads as a search regression
  while every quality number was green. The measurement is now a single shared pass; the quality
  thresholds and the latency budget are separate tests, and the latency budget is scaled by a
  contention probe taken in the same pass. The documented 500 ms is the floor of that budget: an
  idle machine at the reference speed pays exactly it, and a busy or slower one fails with a
  message naming the measured time and the budget it missed. The pass itself keeps a 120 s
  wall-clock budget, so contention can no longer kill it as a timeout.
- `test/installer/dry-run-deps.test.ts` wrote a fixed `lc-test-setup.sh` name into the shared temp
  directory; a second suite run deleting that file between the write and the spawn made bash exit
  127, which reads as a broken installer. The name is unique per process now.
- `test/hooks/restore.test.ts` and `test/hooks/session-snapshot.test.ts` used fixed session ids,
  and the restore lock and the function-hooks claim are fixed paths under the shared temp directory
  keyed by that id: a concurrent run could hold, claim or delete them, and the hook went silent — or
  answered — for a reason the test never set up. Ids are unique per process now.

Test infrastructure only: nothing about the emitted CLI or the daemon changes, and no threshold is
lowered.
