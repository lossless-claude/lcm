---
"@lossless-claude/lcm": patch
---

chore: test setup hooks get the same 20 s as the tests they prepare

Unit tests already get 20 s (`testTimeout`) because setup-heavy tests that take 1–3 s on an idle
machine exceeded vitest's 5 s default under load. Their `beforeAll` and `beforeEach` hooks do the
same setup (opening databases, starting daemons, writing fixtures) but still had vitest's 10 s
hook default, so a loaded run failed them as "Hook timed out" with no defect in the code. Both
projects now set `hookTimeout` to 20 s. A real hang still fails, and hooks that pass their own
timeout keep it.

Test infrastructure only: nothing about the emitted CLI or the daemon changes.
