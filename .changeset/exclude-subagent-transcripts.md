---
"@lossless-claude/lcm": minor
---

Stop `lcm search` from returning subagent transcripts. Claude Code writes a dispatched agent's transcript as `agent-<id>.jsonl` and ingestion keeps it as a session, so ranked recall was competing the user's own history against review panels arguing about diffs — 78% of ingested sessions here, above 90% on some projects. Measured over 202 questions whose answers are human sessions, skipping them gains 14 and loses none (hit@5 0.337 to 0.406, sign test p = 0.0001). The transcripts stay ingested and stay reachable through `lcm grep` and `lcm expand`; only ranked search stops offering them unprompted. `lcm bench build` samples from the same population, so its questions are answerable by the search it grades.
