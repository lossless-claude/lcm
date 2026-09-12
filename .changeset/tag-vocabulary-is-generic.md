---
"@lossless-claude/lcm": patch
---

fix: the tag vocabulary is generic

The learning instruction and the `lcm_store` tool description name five tag prefixes:
`type:`, `scope:`, `project:`, `source:`, `priority:`. The `owner:` and `sprint:` prefixes,
which described one organisation's process, are gone from the guidance; tags already stored
with them are untouched. `lcm_store` describes its target as the promoted layer, the name
`lcm_search` uses for the same layer.
