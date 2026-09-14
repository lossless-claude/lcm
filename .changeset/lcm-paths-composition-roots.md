---
"@lossless-claude/lcm": minor
---

chore: the storage root is constructed at each composition root instead of imported

`defaultLcmPaths` and `lcmPath()` are gone. The CLI's `main()`, `createDaemon()`, and the
hooks builder each build one `LcmPaths` and thread it down through batch compaction,
bootstrap, import, replay state, sensitive-pattern
commands, stats, portable knowledge, and language packs. The package entry point now
exports `createMemoryApi(client)` without constructing an ambient default client.
`daemon/config.ts`'s `socketPath` default is derived from `configPath`'s own directory
instead of resolving the root again.

The paths guard test grows two checks rather than a duplicate: `homedir()` outside the
factory must be a host-harness or user-typed path, and every remaining `lcmHome()` call
site is named as either a composition root or a library fallback still to be threaded.

Library helpers do not resolve the storage root from the ambient environment. Callers
that choose the root pass the resulting `LcmPaths` through every storage access.
