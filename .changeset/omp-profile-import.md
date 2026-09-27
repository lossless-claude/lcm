---
"@lossless-claude/lcm": patch
---

`lcm import` (all providers that include OMP) now discovers sessions under every OMP profile (`~/.omp/profiles/<name>/agent/sessions`), not only the active agent directory. A session id is deduplicated to its newest copy within its own root only, so one profile's session can never mask, or be masked by, another profile's copy of the same id. `lcm import --provider omp`/`--omp` now also reports every root it scanned, so a "0 sessions" result names where discovery looked.
