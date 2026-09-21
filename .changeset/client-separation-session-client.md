---
"@lossless-claude/lcm": patch
---

Client separation pass: session-client identity, capability-bearing transcript adapters, one owner for Claude Code's project-directory name.

`src/session-client.ts` now names the one session-client type (`"claude" | "codex"`), kept deliberately separate from summarizer providers; the hook, events and ingest code import it instead of restating ad-hoc unions.

The transcript-source seam no longer leaks Codex into shared types: the resume cursor became an adapter-opaque `checkpoint`, loaded and persisted through the adapter inside capture's write transaction, and the ingest route reads client capabilities off the adapter (`mayRecoverTail`, `discoverSubagents`) instead of comparing the client string; `POST /prompt-search` takes an explicit `nativeHistory` flag from the Codex hook rather than forking on the client name. Shared hook helpers moved to `src/hooks/tool-events.ts` (tool-event recording) and `src/hooks/daemon-requests.ts` (fire-and-forget daemon requests), so neither client's adapter imports the other's entry-point module.

Claude Code's project-directory slug (`~/.claude/projects/<slug>`) has one owner, `claudeProjectSlug` in `src/daemon/project.ts`: the cwd with every non-alphanumeric character replaced by `-`. `lcm import`, `lcm diagnose` and the daemon's periodic transcript scan previously re-implemented older slash-only variants, so projects whose path contains a dot or underscore silently found no sessions; the periodic scan additionally dropped the leading dash and matched nothing at all. The scan pass is now a named export, exercised directly by tests that pin the slug rule and refuse the old slash-only name.
