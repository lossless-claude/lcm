---
"@lossless-claude/lcm": patch
---

Publish through npm trusted publishing (OIDC) instead of a stored token. 2FA-bypass automation tokens lose direct publish around January 2027, and the stored one had already expired. The workflow now authenticates as itself through the OIDC token it was already granted, and `docs/releasing.md` records the setup.
