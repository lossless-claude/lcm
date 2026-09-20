---
"@lossless-claude/lcm": patch
---

refactor: the restore assembly moves behind one entry point in `src/daemon/restore/`

`createRestore(config, paths)` is the module's only entry point, and it answers one call
with one of three outcomes — the context, an unusable `cwd`, or a fault — so `POST /restore`
no longer throws its way to a status. Everything the route used to hold now sits behind
that seam: which client is asking, whether the restore follows a compaction, the Claude
CLAUDE.md snapshot replay-versus-refresh rule, the Codex byte budget, the passive-capture
insights that ride beside the context, and the fencing. `src/daemon/routes/restore.ts` is
the wire only.

The module opens one project-database connection per call where the route opened up to
four, and the two route suites are now suites of the module: they call `createRestore`
directly against temp project databases instead of driving a daemon over HTTP. The
snapshot's reader moved to `src/daemon/restore/instructions.ts`, so the `homedir()`
allowlist follows it; the route keeps a wire test covering the status and body mapping.
