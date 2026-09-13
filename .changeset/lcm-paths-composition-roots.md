---
"@lossless-claude/lcm": patch
---

chore: the storage root is constructed at each composition root instead of imported

`defaultLcmPaths` and `lcmPath()` are gone. The CLI's `main()`, `createDaemon()`, the
hooks builder and the daemon-facing memory export each build one `LcmPaths` and thread
it down, so a module that needs a location receives it rather than importing a default.
`daemon/config.ts`'s `socketPath` default is derived from `configPath`'s own directory
instead of resolving the root again.

The paths guard test grows two checks rather than a duplicate: `homedir()` outside the
factory must be a host-harness or user-typed path, and every remaining `lcmHome()` call
site is named as either a composition root or a library fallback still to be threaded.

Ten library helpers still fall back to the ambient root when a caller omits paths —
`batch-compact`, `bootstrap`, `auto-heal`, `import`, `memory`, `portable-knowledge`,
`replay-resume`, `sensitive`, `stats` and `language-pack`. They are listed in that guard
and tracked separately, so a custom-root process is sandboxed at its composition root but
not yet along those paths.
