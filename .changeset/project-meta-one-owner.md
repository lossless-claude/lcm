---
"@lossless-claude/lcm": patch
---

A project's `meta.json` has one owner, `src/daemon/project-meta.ts`, with one corrupt-file policy: an update moves an unparsable file aside as `meta.json.corrupt-<timestamp>` and starts again from the caller's keys, and a read treats it as absent. Ingest, compact, promote, git identity and language detection each update their own key and keep every other, so a record no longer loses `git`, `language` or its timestamps depending on which path touched it first. Writes land through a temporary file and a rename, so a crash mid-write cannot leave a torn record.
