---
"@lossless-claude/lcm": patch
---

fix(plugin): a fresh plugin install fetches the released tag, not `main`

The marketplace entry now carries `ref: vX.Y.Z` beside `version`, written by the
same version sync that stamps `plugin.json`. Before, a new install cloned the
default branch's HEAD under the released version's label, so two users on
"0.11.0" could run different code. The publish workflow tags before it publishes
to npm, so the ref is valid as soon as the version commit lands.
