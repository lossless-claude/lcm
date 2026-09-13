---
"@lossless-claude/lcm": patch
---

fix: `lcm install --dry-run` previews the skill copy instead of failing

The dry run exited 1 because the `/memory` skill copy ran for real while its
target directory was only pretended. The skill copy, the removal of the
per-command files earlier versions installed, and the plugin cache cleanup now
all go through the dry-run layer, so a dry run writes and removes nothing. The
skill source is also found when lcm runs from source, not only from `dist/`.
