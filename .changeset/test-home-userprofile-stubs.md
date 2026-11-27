---
"@lossless-claude/lcm": patch
---

chore: tests that move HOME move USERPROFILE with it

On Windows `os.homedir()` reads USERPROFILE, not HOME. Tests that pointed HOME at a fixture home,
in process or for a child, still resolved the test process's own home there, so they failed on
Windows for a reason unrelated to what they test. A child env built from scratch is no exception:
libuv copies the parent's USERPROFILE into a child env that lacks one.

`test/helpers/user-home.ts` now moves both: `stubUserHome(dir)` for the test's own process and
`childEnvWithHome(dir, base?)` for a child. Every suite that set HOME uses them, and `test/home-stub-discipline.test.ts` refuses HOME set any other way in
`test/`, unless the line says why with a `// home-stub: <reason>` comment.

Test infrastructure only: nothing about the emitted CLI or the daemon changes.
