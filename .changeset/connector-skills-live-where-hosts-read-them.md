---
"@lossless-claude/lcm": patch
---

fix: the skill connector installs where Codex and Copilot read it

The `skill` connector for Codex and GitHub Copilot now installs to `.agents/skills/lcm-memory/SKILL.md`, the location both hosts actually read (Codex only scans `.agents/skills`; Copilot also accepts it). One installed file now serves both hosts in a repository that uses both. Installing or removing the skill connector also clears a pre-existing copy at the old location (`.codex/skills/` or `.github/skills/`) so the two copies never coexist.
