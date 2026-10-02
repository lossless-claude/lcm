---
"@lossless-claude/lcm": minor
---

Link sessions to local commits through explicit `git commit` output or matching web-session
trailers during event-time repair. Describe exposes commit references for sessions,
summaries and timeline nodes. Resolved evidence anchors only unknown message times,
with recorded provenance, using the committer date; the author date remains reference
metadata only, and reruns correct legacy author-date commit anchors.
Source bounds prefer known times over capture dates and condensed
bounds read direct summary metadata rather than message subtrees. Provenance migration
does not scan or rewrite messages. Git reads yield the project queue and mutation
lease, writes recheck evidence, and bounds repair touches only changed conversations.
Missing-project skips do not inflate the skipped-session count.
The commit pass can be disabled and never fetches or stores git content.
Hashes from viewed history, bare hex lines and hex-looking words do not establish
commit references or event-time anchors.
