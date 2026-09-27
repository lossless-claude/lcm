---
"@lossless-claude/lcm": patch
---

`lcm import` (all providers that include OMP) now discovers sessions under every OMP profile (`~/.omp/profiles/<name>/agent/sessions`), not only the active agent directory. A profile reached through a symlinked directory is not scanned. A session id found in several roots is imported once (live over archived, else newest, else the active root's copy), and each skipped copy is listed in the import result. `lcm import --provider omp`/`--omp` now also reports every root it scanned, so a "0 sessions" result names where discovery looked.
