---
"@lossless-claude/lcm": patch
---

feat: English is a language pack like every other language

`lcm search` and `lcm grep` no longer drop a hardcoded English stopword list
from every query. English's function words now ship as a built-in language
pack, applied only when English is one of the languages the search is
configured for (the project's recorded author language, or
`search.pivotLanguage`) — the same rule every other language's pack already
followed. A project with no recorded language now loses no function words at
all, for any language, instead of English's alone. Pivot-pack generation on
ingest no longer special-cases English: it is ensured the same way as any
other pivot language, and the built-in pack means that ensure step is a no-op
for English rather than a model call.

A machine that already has a model-generated `~/.lossless-claude/languages/en.json`
now has that file replace the built-in list rather than add to it, the same as
a hand-edited file replaces a generated one for any other language tag.
