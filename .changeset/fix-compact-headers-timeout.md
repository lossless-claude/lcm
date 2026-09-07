---
"@lossless-claude/lcm": patch
---

Fix `lcm compact` reporting `FAILED (fetch failed)` at exactly 5.0m for large conversations. `DaemonClient` previously used the global `fetch`, which applies undici's default 300s `headersTimeout`; `/compact` sends no response headers until the whole job finishes, so any conversation needing more than five minutes was reported as failed while the daemon completed it normally. The client now uses `node:http` directly (no default header timeout), and explicit caller-supplied timeouts surface as `TimeoutError` so they are distinguishable from real daemon failures.
