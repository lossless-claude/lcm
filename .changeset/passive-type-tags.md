---
"@lossless-claude/lcm": patch
---

Give every passive promotion a mapped `type:` tag so type filters can find it. Normalize legacy string-tag encodings and passive category tags on database migration, preserving existing types and archived status. Reject malformed tags at the promoted-memory writer; knowledge import decodes the same legacy encodings, so an earlier export still imports.
