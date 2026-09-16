---
"@lossless-claude/lcm": patch
---

Stopword packs follow the configured languages: the project's recorded author language for `query`, `search.pivotLanguage` for `pivotQuery`, matched on the primary subtag. The words in a query no longer choose a pack, so a mixed-language string cannot activate one neither side would, and a non-English pivot language gets its pack generated at detection. `lcm bench` scores an optional `pivotQuery` per question the way `lcm_search` does; the measurement of the shipped `pivotQuery` is recorded in `docs/search.md`.
