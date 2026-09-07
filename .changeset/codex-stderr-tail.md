---
"lossless-claude": patch
---

Fix `codex-process` summarizer errors hiding the failure reason: the Codex CLI writes a ~279-byte config banner to stderr before any useful output, and the error message kept only the first 200 bytes — all banner. Codex exit errors now skip the banner, keep the tail of stderr (up to 2,000 chars, where the real message is), and usage-limit failures are reported with an actionable message.
