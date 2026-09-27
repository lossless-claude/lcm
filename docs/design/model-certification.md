# Model certification: prove a summarizer endpoint does the job before lcm relies on it

Status: proposal for issue #567. Nothing here is implemented. Citations are `file:function` on `main`; items marked **unconfirmed** were looked for and not verified.

## What it is

A user can point the summarizer at any endpoint lcm can call: an OpenAI-compatible server (local llama.cpp, MLX or vLLM, OpenRouter, DeepSeek), the Anthropic API, or a subscription CLI (`claude-process`, `codex-process`, `copilot-process`, `omp-process`). Config load proves the endpoint is well formed (`src/daemon/provider-config.ts:normalizeNamedEndpoints`); it cannot prove the model behind it writes usable summaries. Today that is discovered in production: the summary gate rejects a cut-off or empty answer at write time (`src/llm/summary-rejection.ts`), after the model is already in use.

Certification runs the production compaction path once, against a shipped synthetic corpus, through one endpoint and nothing else, and turns what it observes into a verdict with reasons. The verdict is stored as a certificate, and `lcm doctor` reports every chain link that is uncertified, stale, or known to fail.

It is never automatic. The user starts it, sees what it will cost, and confirms.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | What is certified | One endpoint, never the chain. A chain advances on a rejected answer (`src/llm/provider-chain.ts:failureAdvancesChain`), so a fallback would hide the failure being measured. |
| 2 | Which endpoints | `openai`, `anthropic`, `claude-process`, `codex-process`, `copilot-process`, `omp-process`: a named endpoint in `llm.providers`, or in the flat form the provider type. `session` is not certifiable from a CLI (see [Coverage](#coverage-by-provider-type)). `auto` is a per-client resolution, not an endpoint: certify the concrete process type it resolves to. |
| 3 | Where it runs | In the `lcm` CLI process, on an in-memory SQLite database, like the bench (`test/bench/summarizer-eval-harness.ts:runEval`). No project database is opened, the daemon is not contacted, and no usage reaches `llm_usage_stats`. |
| 4 | Corpus | The synthetic planted-facts session (`buildSyntheticSession`), moved from `test/bench/` to `src/`. It holds no user content, so a run sends nothing of the user's to the endpoint. |
| 5 | Check outcome | Each check is `pass`, `fail` or `not-decidable`. A provider that cannot report a signal is never failed for it; the certificate records which checks it could not decide. |
| 6 | Verdict | `certified` when every gate check is `pass` or `not-decidable` and the run completed; `failed` otherwise, naming the failing checks. Measurements (latency, tokens, cost, planted facts, compression) are stored but never gate until calibrated. |
| 7 | Storage | A new file, `certificates.json`, under the lcm home, as `LcmPaths.certificatesPath` (`src/lcm-paths.ts`). Not `config.json`: that file is the user's, and lcm writes it only to create it (`src/bootstrap.ts`). |
| 8 | Secrets | A certificate never holds `apiKey` or `baseURL`. The resolved `baseURL` and the resolved key are stored as HMAC-SHA256 values under a per-install key, `body` as a hash (see [Record](#record)). |
| 9 | Staleness | A certificate is stale when the endpoint's type, model, resolved `baseURL`, resolved key or `body` changed, when the resolved `LCM_*` knobs differ, or when the summary contract or corpus changed. No expiry by age. The lcm version and the language are recorded, not compared (see [Staleness](#staleness)). |
| 10 | Runtime use | Warn by default. Refusing an uncertified link is an explicit opt-in, `llm.certification: "require"`. Every existing install is uncertified on the upgrade that ships this. |
| 11 | CLI | `lcm certify [<endpoint>] [--dry-run] [--yes] [--json]`. Not under `lcm bench`, which is the retrieval benchmark (`src/cli/bench.ts:registerBenchCommands`). |
| 12 | Spending | Nothing spends without the user: `--dry-run` prints the estimate and calls nothing; a run prints the estimate and asks; without a TTY it needs `--yes`. A cheap first call and the engine's own fail-fast stop the run at the first failure. |
| 13 | External judge | Not in the verdict. On the synthetic corpus a judge has no privacy cost, but it is a second paid endpoint and needs its own calibration. |

## What "certified" means

A certificate says: this endpoint, sent the requests lcm builds under this summary contract, completed a production compaction of the synthetic corpus, and every answer it gave passed the gate checks.

### Gate checks

| Check | Fails when | Evidence on `main` |
|---|---|---|
| `reachable` | The first call gets no answer: the key is refused (401, 403), the account cannot pay (402), the model id or request is refused (400, 404, 422), the host is unreachable, or a process CLI is missing or fails. A rejected answer still proves reachability. | Error classes as `src/llm/provider-chain.ts:httpFailureAdvances` reads them; the process adapters throw an `Error` of their own. |
| `finished` | Any answer reaches the engine rejected with reason `length` or `max_tokens`: the output budget ran out, usually on reasoning, and the chain's retry at twice the cap did not recover it. This is the "reasoning controlled" check. | `SummaryRejectedError.reason`, thrown by `src/llm/openai.ts` and `src/llm/anthropic.ts`. |
| `non-empty` | Any answer is rejected with reason `whitespace`. | `src/llm/summary-rejection.ts:acceptSummaryText`, applied by the chain and by `src/compaction.ts:summarizeWithEscalation`. |
| `contract` | Any accepted leaf summary lacks a `Files:` line, or any accepted summary's last line does not start with `Expand for details about:`. Every answer must comply: the corpus yields only a handful of calls. | `scoreSummary` in `test/bench/summarizer-eval-harness.ts`, the rule the bench already reports as `formatPass`/`formatTotal`. |
| `shrinks` | Any node ends at the deterministic fallback (`[Truncated from N tokens]`): both the normal and the aggressive answer were at least as long as their input. | `src/compaction.ts:summarizeWithEscalation`; `scoreSummary().isFallback`. |
| `completes` | The engine run ended in an error not covered above. | `runEval` records it as `incomplete`. |

`finished` reads the rejection the adapter already raised. The bench infers truncation instead, from reported output tokens reaching `resolveMaxOutputTokens` (`maxTokensHits` in `runEval`); the certifier does not need that heuristic, and the instrumented summarizer must record `SummaryRejectedError.reason` rather than only the error message, which is all `instrumentSummarizer` keeps today. A stop at the cap on a normal request is first retried once on the same endpoint, with the shorter prompt and twice the cap (`src/llm/provider-chain.ts:createProviderChain`); a stop that retry recovers never reaches the engine and is a measurement, not a failure, as it is in production.

### Measurements (recorded, not gated)

| Measurement | Source |
|---|---|
| Latency per call and total | Wall clock around each call, any provider. |
| Input, cached and output tokens | `SummarizerUsage` (`src/llm/types.ts`); `undefined` stays unknown, never zero. |
| Cost | `costUsd` where the provider prices the call (OpenRouter, the Claude CLI); `premiumRequests` for Copilot. Unknown is not a failure. |
| Aggressive retries | Calls with `aggressive === true`: answers that did not shrink the first time. |
| Cap retries | Attempts the chain repeated on the same endpoint after a stop at the cap: in a one-link chain, every `onFallback` (`src/llm/types.ts:SummarizeContext`), whose `fromProvider` equals its `toProvider`. Each sends the node's input a second time. |
| Planted facts | How many of the five facts survive into the compacted context (`checkPlantedFacts`). |
| Compression | Context tokens after over before (`tokensAfter` / `tokensBefore` in `runEval`). |
| Hidden output | Reported output tokens over the visible answer's estimate (`ceil(chars / 4)`), when output tokens are reported rather than estimated. A high ratio says the model spent output on reasoning the answer does not show: a `body` field the endpoint ignores. **Unconfirmed**: that every OpenAI-compatible server counts reasoning in `completion_tokens`. |

These become gates only after thresholds are calibrated on a named corpus. Each certificate names its corpus version, so its measurements are calibration data for that corpus and no other.

### Language

`not-decidable` for every provider in the first version. lcm has no local language detector: `src/search/language.ts:detectLanguage` asks a model, and asking the endpoint under test to judge its own output is circular. The certificate records the language the run requested (`summarizer.language` when configured, else none). A gate needs either a local detector or a second endpoint as judge; both are follow-ups.

### Coverage by provider type

| Type | `finished` | Output cap | Cost reported | Notes |
|---|---|---|---|---|
| `openai` | decidable (`finish_reason: "length"`) | `max_tokens` | OpenRouter only | Any OpenAI-compatible server. |
| `anthropic` | decidable (`stop_reason: "max_tokens"`) | `max_tokens` | no | |
| `claude-process` | not-decidable | none | yes, list price | lcm passes the CLI no output cap (`src/llm/claude-process.ts:buildClaudeArgs`) and parses no stop reason. |
| `codex-process` | not-decidable | none | no | No cap in `buildArgs` (`src/llm/codex-process.ts`); no stop reason parsed. |
| `copilot-process` | not-decidable | none | premium requests | No cap in `buildCopilotArgs`; JSON mode reports output tokens and premium requests only (`src/llm/copilot-process.ts`). |
| `omp-process` | not-decidable | none | no | No cap in `buildOmpArgs`; the JSON's `stopReason` is typed but not read (`src/llm/omp-process.ts`). |
| `session` | — | — | — | Not certifiable from a CLI: its summarizer needs the daemon's job queue and a live `sessionId` (`src/daemon/summarizer.ts:createSessionSummarizer`). |

Where `finished` is not decidable, `contract` still catches most cut-off answers: a truncated summary rarely ends with the `Expand for details about:` line. The certificate says so rather than reporting `finished` as passed.

## The run

1. Resolve the endpoint from the user's config (`src/daemon/config.ts:loadDaemonConfig`, which applies `normalizeNamedEndpoints`). Refuse when the endpoint is `session`, is not declared, or lists `missingEnv` in this shell.
2. Build a config holding only that endpoint, as the bench already does: `test/bench/summarizer-eval-providers.ts:createEvalSummarizer` passes `{ llm: { provider, providers: { [name]: endpoint } } }` to `loadDaemonConfig` and calls `src/daemon/summarizer.ts:createSummarizer`. `llm.fallback` is empty, so the chain has one link, and `summarizer.mock` is not inherited, so the run cannot certify the mock. The endpoint passed in is the one step 1 already normalized, its `apiKey` and `baseURL` expanded to literals, and the second load gets an empty environment, as the bench's does: re-reading the shell's environment would let `LCM_SUMMARY_PROVIDER` select another endpoint and fail the load. In the flat form the endpoint comes from `flatEndpoint` in `src/daemon/summarizer.ts`, which is module-private today and must be exported. An `apiKey` naming a variable declared in `llm.secrets` ([daemon-endpoint-secrets.md](daemon-endpoint-secrets.md)) has no value in either load; the certifier runs its command itself, under that note's rules, and passes the literal. Unlike doctor, which must not raise a store's prompt, the user started this run.
3. Print the estimate and confirm (see [Spending](#spending)).
4. **Ping.** One call with a `taskPrompt` and `targetTokens: 10`, the path `detectLanguage` uses; every adapter honours `taskPrompt` (`src/llm/prompt.ts:buildSummaryPrompt`). It decides `reachable` before the corpus is sent. For an HTTP endpoint the call still carries the minimum output cap, `resolveMaxOutputTokens(10)` = 1024 tokens (`src/summarize.ts`), 2048 on the chain's retry, so a model that reasons without limit usually fails `finished` here, for a fraction of the corpus's cost.
5. **Corpus.** `runEval` on the synthetic session with `compactEngineConfig({ language })` (`src/compaction.ts`) and `COMPACT_TOKEN_BUDGET`: the same engine configuration the daemon's `/compact` route uses. The engine runs its passes one at a time (`src/compaction.ts:compact` awaits each leaf and condensed pass) and a rejection the chain does not recover throws out of the pass, so a run stops there: a failing endpoint is charged for the attempts up to and including that one, not the whole run.
6. Judge the run (the pure verdict function), write the certificate, print the verdict with reasons.

`LCM_*` tuning variables change `compactEngineConfig`, and with it which messages each request carries. The run reads them from the CLI's environment; the certificate stores the resolved values as `settings`, and a daemon whose own values differ holds a stale certificate (see [Record](#record)). The fix is the one doctor already gives for a missing variable: `lcm daemon restart` from the shell that certified.

## Spending

Certification calls a model the user pays for, in money, subscription quota or premium requests. The rules:

- Nothing starts a run but `lcm certify <endpoint>`: not the daemon, `lcm doctor`, `lcm install` or a session hook.
- Before any call, the command prints: the endpoint, its type and model, who bills the calls (the API key's account, the CLI's login, GitHub premium requests, or a local server), the attempt count, and upper bounds on billed answers, input and output tokens, each marked **unknown** where the adapter cannot enforce it.
- A price is printed only when one is known. lcm has no price table, so for most endpoints the dollar figure is "unknown until run", and the run reports what the provider priced afterwards. For `copilot-process` the estimate is attempts × about 0.33 premium requests, the rate `docs/configuration.md` ("Token cost reporting") states.
- With a TTY the command asks before calling; without one it refuses unless given `--yes`. `--dry-run` prints the estimate and exits with no call.
- One endpoint only: a run never spends on a fallback.
- The run counts provider attempts through `onAttempt`, which `runLink` calls before the attempt starts (`src/llm/provider-chain.ts`), and aborts before one beyond the estimate's bound. Billed answers are counted through `onUsage` and reported; the guard cannot stop a re-send inside one attempt, which the adapter's fixed loop bounds instead.

The estimate is deterministic, and bounds each level where lcm's code fixes it:

- **Engine calls.** The synthetic corpus is sized for three leaf chunks and at most one condensation under production config (the doc comment on `buildSyntheticSession`); each node takes at most two calls (`summarizeWithEscalation`: normal, then aggressive; the fallback calls no model); plus the ping: nine.
- **Attempts.** A normal call whose answer stops at the cap is retried once on the same endpoint; an aggressive call never is (`overrunCap` in `src/llm/provider-chain.ts`). At most three attempts per node and two for the ping: fourteen. The process adapters never raise a stop at the cap, so they get no retry: nine.
- **Billed answers.** The `openai` and `anthropic` adapters send a request up to three times per attempt, re-sending after an empty answer or a transient failure (`MAX_RETRIES` in `src/llm/openai.ts` and `src/llm/anthropic.ts`); an empty answer is billed and reported through `onUsage` before it is rejected. At most three per attempt, forty-two per run. Beneath that loop the SDK clients, built without `maxRetries`, retry a connection failure, 408, 429 or 5xx twice more by their default (`openai` 6.32, `@anthropic-ai/sdk` 0.39), so one attempt can make up to nine requests; whether a failed request is billed is the provider's rule and **unknown** to lcm. A process adapter runs its CLI once per attempt, with no retry of its own.
- **Input.** Each billed answer re-sends its node's input: once per node when every first answer is accepted, at most nine times, so between about once and nine times the corpus's ~73k tokens.
- **Output.** An HTTP answer is capped at `resolveMaxOutputTokens` of its target (`src/summarize.ts`), twice that on the cap retry. A process adapter passes its CLI no cap (see [Coverage](#coverage-by-provider-type)), so its output bound is **unknown**, and the estimate prints it so.

**Unconfirmed**: the exact chunk count under the current defaults (not re-run for this note); the estimator should compute it from the corpus's token counts and `compactEngineConfig`, not hard-code it.

## Certificates

### Record

`certificates.json` holds the latest certificate per endpoint name, written atomically (temp file, then rename). A failed verdict is written too: it is evidence the endpoint does not do the job.

```json
{
  "version": 1,
  "certificates": {
    "deepseek": {
      "subject": {
        "type": "openai",
        "model": "<model>",
        "baseURL": "hmac-sha256:<MAC of the resolved URL>",
        "credential": "hmac-sha256:<MAC of the resolved key>",
        "body": "sha256:<hash of the validated body, keys sorted>"
      },
      "settings": {
        "contextThreshold": 0, "freshTailCount": 0, "leafMinFanout": 0, "condensedMinFanout": 0,
        "condensedMinFanoutHard": 0, "leafChunkTokens": 0, "condensedTargetTokens": 0
      },
      "contract": "sha256:<hash>",
      "corpus": "synthetic-planted@sha256:<hash>",
      "language": "pt-BR",
      "lcmVersion": "<PKG_VERSION>",
      "certifiedAt": "<ISO 8601>",
      "verdict": "certified",
      "checks": [
        { "id": "reachable", "status": "pass" },
        { "id": "finished", "status": "pass" },
        { "id": "language", "status": "not-decidable", "detail": "no local detector" }
      ],
      "measurements": {
        "calls": 5, "attempts": 5, "billedAnswers": 5, "latencyMs": 0, "inputTokens": 0, "outputTokens": 0,
        "costUsd": null, "premiumRequests": null, "plantedFacts": [4, 5], "compression": 0.0
      }
    }
  }
}
```

- `baseURL` and `credential` fingerprint what the endpoint resolved to: after `${NAME}` expansion (`src/daemon/provider-config.ts:normalizeNamedEndpoints`) and, for an `anthropic` endpoint without a key, after `ANTHROPIC_API_KEY` is read. A rotated key, or a variable now naming another host, makes the certificate stale. So does a new key for the same account: lcm cannot tell an account from a key, and re-certifying is the price of never admitting one that was not tested.
- Both are HMAC-SHA256 under a per-install key, `certificates.key` in the lcm home (`LcmPaths.certificatesKeyPath`), made as `daemon.token` is (`src/daemon/auth.ts`: 32 random bytes, a `0600` file written through a temp file). A keyed MAC, not a salted hash: with the salt stored beside it, anyone who reads `certificates.json` can test a guessed key, and the keys here include short local-server tokens; without the key the file says nothing about them. A lost key makes every certificate stale, and doctor names that as the reason. `body` is never expanded, so it is hashed as validated.
- A process endpoint has neither field: its account is its CLI's login, which lcm does not read, so a certificate does not see a change of login.
- `settings` holds the seven values `compactEngineConfig` reads through `resolveLcmConfig` (`src/db/config.ts`), resolved, so an unset variable and its default compare equal. They are compared, not only recorded: they decide the chunks, and so the requests the run exercised. Doctor names the variable that differs (`LCM_LEAF_CHUNK_TOKENS`, say).
- `contract` hashes only what the code defines, so the run, `lcm doctor` and the daemon compute the same value from any shell and any project: the system prompt (`LCM_SUMMARIZER_SYSTEM_PROMPT`), the leaf and condensed prompts rendered from a fixed context with no language (`src/llm/prompt.ts`), and `LCM_CONFIG_DEFAULTS` (`src/db/config.ts`).
- `language` is run context: recorded, not compared. Without `summarizer.language` it depends on the project (`src/search/pivot-language.ts:projectAuthorLanguage`), while a certificate is global, and its check is not decidable.
- `corpus` hashes the generated session, so editing `buildSyntheticSession` changes it without a hand-bumped constant.

### Staleness

A certificate applies to the current endpoint when `subject`, `settings`, `contract` and `corpus` all match. `lcm doctor` names the field that differs ("model changed", "key changed", "`LCM_LEAF_CHUNK_TOKENS` differs", "summary prompts changed").

The issue lists the lcm version as a staleness key. This note records it and does not compare it: lcm releases often, and a version key would mark every certificate stale on every upgrade, asking the user to pay again even when nothing that reaches the model changed. The contract hash captures the prompts and the engine defaults, which are what a release usually changes. What it misses is a change to how an adapter builds its request (a new field the openai adapter sends, say); an adapter change that matters should change the contract hash by hand, via a constant it includes. This is the one decision a reviewer is most likely to flip.

No age expiry. A hosted model can change behind an unchanged id, but no age is known to catch that, and any number chosen now would be uncalibrated.

## How lcm uses certificates

| Surface | Behaviour | Slice |
|---|---|---|
| `lcm doctor` | One check per chain link in category `Summarizer`, next to `addNamedEndpointChecks` (`src/doctor/doctor.ts`): `pass` certified and current; `warn` uncertified or stale, with `Fix: lcm certify <name>`; `fail` when the current certificate's verdict is `failed`. No check for `session`. A `Summarizer` failure does not block `lcm install` (`src/doctor/types.ts:blocksInstall`). | 3 |
| Daemon startup | One `summarizer.uncertified` warning per chain link without a current certificate, judged against the daemon's own resolved endpoint and settings, as `src/daemon/summarizer.ts:logUnavailableEndpoints` does for missing variables. | 3 |
| `llm.certification: "require"` | A link without a current `certified` certificate is left out of the chain, as a link with `missingEnv` is. `summarizerAvailability` (`src/daemon/provider-config.ts`) reports it with its reason, so `/health` and doctor show it; with every link left out, each summary fails with `SummarizerUnavailableError`. `session` is exempt. Compared where the daemon knows the values: the settings and an environment key at config load; a key declared in `llm.secrets` in the link's adapter build (`link.summarizer()`), the only place the daemon resolves it, where a mismatch fails the build with an error `failureAdvancesChain` passes, as [daemon-endpoint-secrets.md](daemon-endpoint-secrets.md) does for `CredentialUnavailableError`. A new certificate takes effect after `lcm daemon restart`. | 4 |
| `/health` | Unchanged until `require` exists. Doctor reads `certificates.json` directly, since it shares the lcm home. When `/health` gains the reason, `isAvailability` in `src/doctor/doctor.ts` must accept it. | 4 |

The certificate holds what the run resolved, and the daemon compares what it resolved. A run in the user's shell expands `${NAME}` and reads `LCM_*` from that shell; the daemon from its own (the split `lcm doctor` already reports as "the running daemon's environment" versus "this shell"). Where they differ the certificate is stale for the daemon, so `require` never admits a host, key or configuration the run did not exercise. Doctor judges in this shell, except for a key declared in `llm.secrets`: doctor does not run the command, so it reports the daemon's comparison from `/health`. A `POST /certify` route would run in the daemon's environment and could reach the session provider through its job queue; it is deferred, since it puts a paid, minutes-long run on the daemon, and the daemon's environment changes at each respawn, so its certificates would need the same comparison.

## CLI

```
lcm certify                       # every chain link and its certificate state; calls nothing
lcm certify <endpoint> --dry-run  # the estimate; calls nothing
lcm certify <endpoint>            # estimate, confirm, run, store, print the verdict
lcm certify <endpoint> --yes      # no confirmation (required without a TTY)
lcm certify <endpoint> --json     # the certificate as JSON
```

The name follows the CLI's shape: a top-level verb for an action (`compact`, `promote`, `diagnose`), `--dry-run` for a preview that writes and calls nothing (`compact`, `import`, `promote`), `--yes` to skip a confirmation (`sensitive purge`), `--json` for structured output. `<endpoint>` is a name in `llm.providers`, or in the flat form the provider type. The command needs neither `createDaemonClientOrExit` nor `admitCliDatabaseWork` in `bin/lcm.ts`: it opens no project database. Help goes in `src/cli-help.ts`, and the command in `docs/configuration.md` in the same PR.

Exit status: 0 certified, 1 failed or refused. `--dry-run` exits 0.

## Sharing code with the bench

The bench stays the developer's view of the same run. Moved to `src/` (e.g. `src/certify/`), imported by both:

- `buildSyntheticSession` and its planted facts;
- `instrumentSummarizer`, extended to keep the rejection reason, to attach `onAttempt` and `onFallback` to the context it passes down as it attaches `onUsage` today, and to keep every usage report of a call rather than the last;
- `scoreSummary`, `checkPlantedFacts`, `runEval`.

Staying in `test/bench/`: `loadCorpusDir` and `writeResult` (exported real sessions, results on disk) and `summarizer-eval-providers.ts` with its `LCM_EVAL_*` variables. Both already build the summarizer through `createSummarizer` over one named endpoint, so nothing provider-specific is duplicated.

The move drops the bench's `emptyContentFallback`: it detects `out === text.slice(0, 500)`, a fallback `src/llm/openai.ts` no longer has (an empty answer now throws `SummaryRejectedError`). Its offline test ("detects the production empty-content fallback") builds the slice itself, so it passes against behaviour production no longer has.

Nothing under `test/` reaches the npm package or the plugin bundle (`tsconfig.json` excludes it from `dist/`, `.npmignore` lists it, and nothing reachable from the entry points of `scripts/build-bundle.mjs` imports it), which is why the corpus has to move before the CLI can use it.

## Slices

1. **Shared run and verdict** (first PR). Move the corpus, instrumentation, scoring and `runEval` to `src/certify/`; point the bench at them; drop `emptyContentFallback` and its test; record `SummaryRejectedError.reason` per call, and attempts, cap retries and billed answers through `onAttempt`, `onFallback` and `onUsage`. Add a pure `judgeRun(run, endpointType)` returning checks and verdict, with the decidability table above, and the pure certificate functions: subject (keyed), settings and contract fingerprints, and `certificateState(current, stored)` returning certified, failed, stale (with the field) or uncertified. Unit tests on fixtures and fake summarizers only; no live call, no CLI, no file written. No user-visible change, so no changeset; `docs/summarizer-bench.md` updated for the new locations.
2. **`lcm certify`**: `certificates.json` and `certificates.key`, the estimate, the confirmation, the ping, the run. `docs/configuration.md` and `src/cli-help.ts`; a changeset.
3. **Reporting**: the doctor check and the startup warning.
4. **Enforcement**: `llm.certification: "require"`, and its reason in `summarizerAvailability` and `/health`.

Follow-ups, each separable: a language gate; calibrated thresholds for planted facts, compression, latency and cost on a named corpus; the user's own sessions as an optional corpus (read-only, never leaving the machine except to the endpoint under test, with its own consent and corpus version); an external judge; a price lookup for the estimate; `POST /certify` for the daemon's environment and the session provider.

## Unconfirmed

- The synthetic corpus's call count under the current defaults: taken from the doc comment on `buildSyntheticSession`, not re-run.
- That OpenAI-compatible servers include reasoning in `completion_tokens` (the hidden-output measurement).
- Whether a provider bills a request that failed with a 5xx or a timeout: the billed-answer bound counts only answers that reported usage.
- Whether `src/daemon/config.ts` rejects unknown keys under `llm`: no such check was found (it deep-merges the file over defaults), so storing certificates in `config.json` was possible; it was rejected for the reasons in decision 7, not because it would fail to load.
- A price source for the estimate: none in lcm; OpenRouter's model listing was not checked.
- How often the process CLIs change their default model under an unchanged `model` field: a certificate cannot see it.
