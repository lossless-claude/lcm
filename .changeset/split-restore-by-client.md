---
"@lossless-claude/lcm": patch
---

Split `POST /restore` into one builder per client. Claude and Codex never shared an assembly — different tables, different blocks, different response bodies — but shared one handler and an `isCodex` boolean that branched in seven places across two hundred lines. The route now validates the request and dispatches to `buildClaudeRestore` or `buildCodexRestore`, neither of which knows the other exists. No behaviour change.
