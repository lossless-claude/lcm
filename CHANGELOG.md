# @lossless-claude/lcm

## 0.11.0

### Minor Changes

- 48346a8: Add native Codex lifecycle hooks for automatic restoration, prompt recall, incremental capture, and continuity across compaction. Preserve unrelated hooks and report configuration separately from host trust and activation.

  Include active and archived Codex sessions in the default import replay selection, reuse incremental ingestion across hooks and imports, and keep internal Codex summarization out of captured history.

- a15ffd7: Stop `lcm search` from returning subagent transcripts. Claude Code writes a dispatched agent's transcript as `agent-<id>.jsonl` and ingestion keeps it as a session, so ranked recall was competing the user's own history against review panels arguing about diffs — 78% of ingested sessions here, above 90% on some projects. Measured over 202 questions whose answers are human sessions, skipping them gains 14 and loses none (hit@5 0.337 to 0.406, sign test p = 0.0001). The transcripts stay ingested and stay reachable through `lcm grep` and `lcm expand`; only ranked search stops offering them unprompted. `lcm bench build` samples from the same population, so its questions are answerable by the search it grades.
- c162f56: First function-hooks module (Claude Code early access, behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`), in `hooks/lcm-hooks.ts`. One `tool.call` hook replaces the PostToolUse and PostToolUseFailure command hooks: it runs after the tool, reads success or failure from the result, and posts the call to the daemon's new `POST /tool-event` route, which writes the same passive-learning rows the command hook wrote. A `prompt.submit` hook replaces UserPromptSubmit: `/prompt-search` now accepts `recordEvents` and `format: "context"`, and the rendered memory context rides as hidden context on the prompt. The learning instruction moves from every prompt into the system prompt's `memory` section once per session via `prompt.section`, so it stops costing about 1 KB per message. A `turn.complete` hook replaces the Stop hook's snapshot: `/ingest` now derives the transcript path from `session_id` and `cwd` when none is given. When the daemon has idled out, the module restarts it with `lcm daemon start --detach` and retries once, as the command hooks did through `ensureDaemon`. No `node` process is spawned per tool call, per prompt or per turn while the module is loaded. While the flag is set, `lcm post-tool`, `lcm user-prompt` and `lcm session-snapshot` stay silent so nothing lands twice; the test suite clears the flag so a developer's own session cannot change its results. A daemon without the new routes is reported once per session, not per call.
- 386ac67: Migrate the stdio MCP server to protocol revision 2026-07-28 with TypeScript SDK v2. The
  earlier 2025-11-25 revision is still served, so which one a connection uses is the
  client's choice; only the newer one carries the result envelope. The seven tools and both
  entrypoints remain available, and the doctor MCP probe uses the new protocol.
- cf37e51: Rank sessions by relevance rather than by size. `lcm search` scored a session by the reciprocal rank of the best position any single one of its rows reached, so a long session — entering the candidate pool many times — landed a row high on almost any query and crowded out shorter, more relevant ones: measured, one 368 KB session took 11 of 13 top-5 slots on unrelated questions. Session scores are now damped by the session's message count, the way bm25 already damps a message by its length. Chosen on five corpora and graded once on four it had never seen, hit@5 moves 0.269 to 0.320 (+13 questions against −3, sign test p = 0.02), improving on every held-out corpus.
- 9246ee0: New summarizer provider `llm.provider: "session"` (Claude Code function hooks, early access). Instead of calling an API, the daemon hands each summarization job to the function-hooks module of the live session that owns the transcript, which answers through the session's own client: `$.model.complete` with `haiku` for leaf chunks, `$.model.fork` for condensed nodes, `complete` again when the fork has no warm cache. The module serves only its own session's jobs, through a long-poll on `GET /summarize-jobs/next` and `POST /summarize-jobs/:id`, and spends at most `sessionSummarizerMaxOutputTokens` output tokens per session (plugin `userConfig`, default 50000, 0 disables). A job unanswered within 20 s, or answered with an error, goes to `llm.fallbackProvider` when set and to today's `auto` resolution otherwise; a provider the user named explicitly is never bypassed. Usage lands in `llm_usage_stats` as `session:haiku` or `session:fork`, with `calls_estimated` counting the `complete` calls whose tokens are estimated. The engine keeps all DAG bookkeeping; triggers (PreCompact, SessionEnd) do not change.

### Patch Changes

- ea10a75: Write `lcm bench build --generator llm` questions in the language the corpus's author asks in. The generator paraphrased whatever prompt it was handed, so questions inherited the prompt's language: 58 of 60 generated questions came out English against 11 of 13 hand-written ones in pt-BR, because the sampled prompts are mostly pasted code and tool output. Such a set measures same-language paraphrase recall, a task the person never performs. The language is now read once per build from a sample of the corpus's human turns, recorded on the file as `language`, printed by `run`, and overridable with `--language` (`LCM_BENCH_LANGUAGE` in the corpora harness); a build that cannot tell fails instead of defaulting to English. The corpora harness builds with the LLM generator, since mechanical templates are English by construction.
- 2280011: Four correctness fixes in `lcm bench`, all confirmed by the review panel on #361. Repeated-prompt detection now compares prompts trimmed, so the same text with a trailing newline in another session no longer slips through as unique evidence, and the grouping is bounded to prompt-sized rows instead of loading every repeated paste in the corpus. Session labels are matched trimmed, so a hand-curated `sessionId` with a stray space scores its hit instead of silently missing. A benchmark file that exists but does not parse now reports the parse error rather than "No benchmark file", whose advice — run `bench build` — would have overwritten the file being fixed.
- 147214e: Cut both `lcm bench` columns at the same point. The score is over sessions but search ranks rows, so asking for `k` rows and then deduplicating by session surfaced 3.3 sessions per query on a real 105-session corpus instead of `k` — several rows of one session ate the budget — while the ripgrep baseline walks its hits until it has `k` distinct sessions and always fills them. The comparison handed grep more chances than search on the same question. Search now gets a row budget that fills every slot; the reported hit rates are unchanged on both local benchmarks, so this removes a confound rather than moving a number.
- 59f5bf3: Report what `lcm bench` actually measures. The `--json` report exposed a single-source hit rate under the name `searchRecall`, and `bench build` sampled any user prompt — including harness boilerplate and text repeated across sessions, neither of which a single source label can score: search can return a genuinely correct session and be counted as a miss. `build` now only samples prompts whose text occurs in exactly one session, questions take an optional `sessionIds` list whose every entry scores as a hit, and the report fields are `searchHitRate` and `grepHitRate` with `hit@k` in the human output.
- f34a965: Add `scripts/bench-corpora.mts`, which scores `lcm bench` across several local project corpora and pools the result. A single benchmark cannot separate a ranking improvement from noise: two changes that read as clean wins on one 13-question set did not survive pooling over 221 questions from eight corpora, one of them turning negative and pushing p95 past the latency budget. Retrieval ranking changes are measured here from now on.
- a3efd52: Make `lcm bench build --generator llm` produce recall questions instead of keyword lookups. Told only to "paraphrase", the generator returned the prompt's own vocabulary in a new sentence order: over 59 generated questions the mean share of question terms also present in their own prompt was 0.55, against 0.11 for the hand-written reviewed set, and search scored that easier set 0.75 where it scores the hand-written one 0.39. The generator is now handed the source prompt's distinctive words as words to avoid, and a generated question that still reuses more than half of them is rejected. On the same corpus that yields 60 questions whose overlap profile (mean 0.11, median 0.08) and difficulty (search 0.35) match the hand-written set — a benchmark large enough to tell a ranking change from noise.
- aa3fb84: Stop `lcm bench build` from sampling pasted tool output as a question source. A `role='user'` message often carries a grep listing, a `git push` transcript, or a directory listing rather than a human turn, and those read as highly distinctive — unique paths and hashes — so sampling favoured them: 55% of one 60-question set. A question generated from a listing asks about the listing, not about anything a person wanted to recall, and it is usually answerable from several sessions, which a single-label score counts as a miss.
- 9064418: Count only scorable sessions when `lcm bench build` detects repeated prompts. The uniqueness pass grouped over every conversation while sampling draws only from conversations with a nonempty session id, so a prompt held once by a real session and once by a session-less conversation counted as two and was excluded — though it is unique among the sessions a question can be scored against.
- cb22e30: Passive-learning events extracted from a user prompt now dedup on `(session_id, sha256(prompt))`, so a session where both the command hook and the function-hooks module run records each prompt once. A prompt carries no id both paths can see — the command hook's stdin has `prompt_id`, the module's `prompt.submit` has only the text — which makes the content hash the only shared key. Events sidecar schema v5 adds the `prompt_hash` column and its index; rows written earlier have no hash and never dedup against.
- 7fc82c0: Removed `compaction.leafTokens` and `compaction.maxDepth`, which nothing read. Tuning them changed nothing, which made them a trap. A config file that still sets them keeps loading; the values are ignored as before. `compaction.autoCompactMinTokens` stays: `lcm compact` uses it as the token threshold that picks which conversations to compact.
- f716898: Return linked source messages when lcm_expand reaches a leaf summary instead of an empty expansion. Preserve the requested depth for condensed summaries.
- fc436a1: Follow Claude Code's `$.fs` rename in the function-hooks module: `readFile`, `writeFile`
  and `listDir` became `read`, `write` and `list` in 2.1.267. The session claim had stopped
  being written, so the command hooks stayed active alongside the module.
- 89a9cba: Drop a query's function words in the language it is written in, not only in English. Query preparation stripped English stopwords and let every other language's through, so a pt-BR question carried "que", "como", "para" into the OR query and BM25 rewarded the long sessions that contain them everywhere; on the 74 pt-BR bench questions that alone cost 0.419 vs 0.486 hit@5. Instead of a fixed list per language, the daemon now generates a language pack (`~/.lossless-claude/languages/<tag>.json`) the first time a corpus in a new language is seen: after an ingest, a project with no recorded language and enough human turns is sampled, the model names the language, `meta.json` records it, and the pack is written once and reused. A pack applies to a query when two or more of its words are that language's function words. Packs are reviewable JSON; deleting one regenerates it. Mock or disabled summarizers skip the step, and a failing provider is logged once per project.
- 0532908: `LCM_HOME` moves everything lcm owns — the daemon's port, token and pid, the per-project databases, the events sidecars, the logs — somewhere other than `~/.lossless-claude`. Every path now resolves through `lcmHome()` instead of computing `join(homedir(), ".lossless-claude")` at 49 separate call sites, and the function-hooks module honours the same variable when it reads the daemon's address.

  This makes lcm runnable against a scratch directory. Until now the only way to point it elsewhere was to move `HOME`, which takes the host's own configuration with it — so a sandbox for lcm could not be built without breaking the tool under test.

- ff632eb: Refactored `hooks/lcm-hooks.ts` for readability, with no behaviour change: the 78-line registration body became one function per hook, the 65-line summarize poller split into fetching, classifying and serving, timings and the "command not found" exit code became named constants, and the config parse no longer swallows its error. The daemon's "no such route" log now names the route in every case.
- 4340c0b: `LCM_HOME` now reaches every path lcm resolves. Three sites spelled the root through an aliased import (`hd()`, `deps.homedir`, `_homedir2()`) and kept pointing at `~/.lossless-claude` regardless of the variable: purging all projects, one of the session-snapshot config reads, and `lcm doctor`, which now takes the lcm home as an injected dependency like it already took the user's home.

  Adds `LcmPaths`, one object holding every location derived from a single root, and a test that fails when the root is named outside the factory.

- fc436a1: Serve both MCP protocol revisions rather than only 2026-07-28. Claude Code opens a stdio
  server on 2025-11-25 unless `MCP_PROTOCOL_NEGOTIATION` is set to `auto`, so refusing that
  opening left the seven tools unreachable under the default. Both revisions now reach the
  same tools with the same results.
- 236a34a: Publish through npm trusted publishing (OIDC) instead of a stored token. 2FA-bypass automation tokens lose direct publish around January 2027, and the stored one had already expired. The workflow now authenticates as itself through the OIDC token it was already granted, and `docs/releasing.md` records the setup.
- 07aaacd: Leaf and condensed summaries now see the preceding chunk's summary. The compaction engine always passed it, but `SummarizeContext` had no field for it and no provider rendered it, so `<previous_context>` was always `(none)` on the daemon path and `/compact`'s `previous_summary` was accepted and ignored.
- 01e3078: The command hooks now stay silent only when the function-hooks module has actually claimed the session, not merely because `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. The module writes `<tmpdir>/lcm-claim-<session_id>.json` at `session.start`, and `lcm post-tool`, `lcm user-prompt` and `lcm session-snapshot` require both the variable and that claim before standing down. A module that fails to load no longer takes passive capture down with it: without a claim the command hooks record as they always did.
- 0d91af9: The function-hooks module now restores the session's memory itself, through a `prompt.context` block named `lcm`, instead of leaving it to the `SessionStart` command hook. The hook's other half — pruning the events sidecar and promoting what an earlier session left behind — moved to the daemon's new `POST /session-scavenge`, which the module fires without waiting; the command hook awaited it with the session blocked behind it. `lcm restore` stays in place for sessions without the module, and stands down when the module has claimed the session.

  The mark that tells a post-compaction restore from a fresh one now lives in the project database (`session_compactions`) instead of daemon memory, so a daemon restart inside the 30-second window no longer makes a restore replay the wrong content. `prompt.context` carries no reason for firing, which makes that mark the only signal the module has.

- 02722ac: Split `POST /restore` into one builder per client. Claude and Codex never shared an assembly — different tables, different blocks, different response bodies — but shared one handler and an `isCodex` boolean that branched in seven places across two hundred lines. The route now validates the request and dispatches to `buildClaudeRestore` or `buildCodexRestore`, neither of which knows the other exists. No behaviour change.
- 94c2ee2: Passive-learning events now dedup on `(session_id, tool_use_id)`. Both the command hook and the function-hooks module receive Claude Code's call id, so a session that runs both paths records each tool call once instead of twice. Events schema v4 adds the column and its index; a database written before it migrates on open.
- fc436a1: `npm run typecheck:hooks` refuses to run against declarations generated by a different
  Claude Code build. It held the module to an API three releases old and passed, which is
  how the `$.fs` rename reached a live session. It now names the installed version and says
  to restart before regenerating, since `/plugin-types` writes what its own session knows.

## [0.10.0] - 2026-09-08

### Added

- `llm.reasoning` config key: passes a reasoning object (e.g. `{"effort":"minimal"}`) to the `openai` summarizer, so OpenAI-compatible models like GLM Flash stop thinking at length before every summary (#342).
- `copilot-process` summarizer provider, backed by the GitHub Copilot CLI. `auto` resolves to it once a client identifies itself as `copilot`; today select it with `LCM_SUMMARY_PROVIDER=copilot-process` (#313).
- Normalized token cost reporting across all three process providers. `llm_usage_stats` now stores input, cached, and output tokens alongside the total, and `lcm import --replay` prints the breakdown.
- Native evidence search with session fusion (#321), FTS5-ready natural-language queries with stopword filtering and AND→OR fallback (#311), and `lcm bench build|run` for real-corpus recall benchmarks.
- Summarizer evaluation bench under `test/bench/` with OpenRouter, OpenAI-compatible and `claude-process` providers (#338).
- Resumable replay runs: manifest/ledger tables, resume planner, signal drain, `--restart` (#302, #326, #330, #331).
- Prompt-time memory injection budget and deduplication (#220), feedback-based reranking of recalled memories (#218), stale-memory review pipeline (#221), auto-promotion of reinforced passive-learning patterns (#217).
- `lcm stats` reports summarizer usage: calls, the token breakdown and the cost, shown once a call has been recorded.

### Changed

- `codex-process` reads its usage from `codex exec --json` instead of the stderr banner, gaining an exact input/cached/output split (the stderr total remains a fallback for older Codex builds).
- `claude-process` reads `--output-format json`, so it now reports token usage and cost.
- The `claude-process` summarizer subprocess is isolated from user plugins, MCP servers and settings (#328).
- Summary output cap follows the requested target instead of a fixed constant (#336).
- `lcm daemon start` is idempotent; `stop`/`restart` added; the daemon carries a content-hash build fingerprint and `lcm doctor` checks the real plugin install (#325, #329).
- Tag prefix `category:` normalized to `type:` everywhere (#212, #219).
- Token usage reporting extended to the HTTP summarizer providers. `openai` and `anthropic` now emit the same normalized accounting, so the default path off the Claude CLI no longer records a summarizer that appears to consume nothing; against an OpenRouter base URL the real charged cost is requested and recorded (#345).
- `llm_usage_stats` stores the reported cost in `cost_usd_total` alongside a `calls_with_cost` counter. An absent cost stays NULL and prints as `unknown`, never `$0.00`, and a partially priced run reports "N of M calls priced" so it cannot pass for a complete total (#351).

### Fixed

- Summarizer fails on empty model output instead of echoing the input back as a summary (#341).
- Hooks: `PostToolUseFailure` registered, hook POSTs bounded by deadlines, sensitive paths screened on tool failures and in the Bash command prefix, never exit non-zero on malformed stdin (#334).
- SQLite `datetime('now')` columns read as UTC.
- `DaemonClient` uses `node:http`, removing undici's 300 s headersTimeout false failures on `/compact`.
- `lcm_search` natural-language queries no longer return empty on AND-only FTS5 matching (#311).
- Restore no longer echoes CLAUDE.md on startup/resume, captures it once when cwd is `$HOME`, and shares SQLite connections throughout (#271).
- VS Code and Codex `lcm` workflows restored (#227); plugin hook commands point argv[1] at the CLI so they actually run (#272).
- Session-end fire-and-forget requests send the daemon auth header.
- `llm.reasoning` is rejected at config load unless it is a JSON object, instead of failing later as an opaque provider HTTP error inside the unattended `/compact` route (#343).
- Search no longer hides summaries. Session fusion emitted one message per matching session and exhausted the limit on its first pass, so no summary could surface once the session count reached the limit, however well it scored (#353).
- The recall gate runs the daemon's `/search` path instead of concatenating candidate lists by hand, and covers the message/summary mix that session-level recall is blind to (#356).

## [0.8.1] - 2026-03-30

### Added

- User notification when sensitive data is filtered from LCM history (closes #178)

### Fixed

- Compact-restore test isolation — eliminate tmpdir() contamination (#184)

### Changed

- Quality-gates CI: label-based merge requirements (#185)
- autoimprove.yaml: add missing forbidden paths (closes #182) (#183)

## [0.8.0] - 2026-03-28

### Added

- Connection pooling for sidecar EventsDb (issue #131)
- Portable knowledge export/import commands — `lcm export`, `lcm import-knowledge` (issue #132)
- Pool stats observable — `lcm stats --pool` + `GET /stats/pool` daemon endpoint
- AR coverage gate CI workflow
- Copilot auto-review on all PRs

### Fixed

- `post-tool` command not registered in CLI dispatcher (#162)
- Security: upgraded hono, rollup, picomatch (3 high CVEs)
- Security: CodeQL hostname regex escaping + sanitizeError in daemon
- Atomic meta.json write in `importKnowledge` — prevents corruption on crash mid-write
- `redaction_stats` CHECK constraint migration for v0.7.0 → v0.8.0 upgrades (adds `'gitleaks'` category)

## 0.1.0

Initial release under `@lossless-claude/lcm`.
