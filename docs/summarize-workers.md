# Run replay and evaluation with summarize workers

Dedicated interactive Claude Code and Oh My Pi sessions can summarize stored
sessions from any project. Keep them open while replay or summarizer evaluation runs. Each worker claims
one pool job at a time; ordinary sessions continue serving only their own jobs.

## Start workers

Install lcm in the host first. For Claude Code, launch one dedicated session in
each of K terminals:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 LCM_SUMMARIZE_WORKER=1 \
  LCM_SUMMARIZE_WORKER_MODEL=haiku \
  LCM_SUMMARIZE_WORKER_MAX_OUTPUT_TOKENS=50000 claude
```

For OMP with the lcm hook installed:

```sh
LCM_SUMMARIZE_WORKER=1 LCM_SUMMARIZE_WORKER_MODEL=haiku \
  LCM_SUMMARIZE_WORKER_MAX_OUTPUT_TOKENS=50000 omp
```

`sonnet` is also accepted. Claude checks the model against its allowlist; OMP
uses the newest matching Anthropic model in its registry and that registry's
credentials. OMP resolves `pi-ai` from its CLI installation; no lcm dependency
installation is needed. Workers use their host's credentials and quota.

The output allowance belongs to each loaded worker module. Requests use the
smaller of the job's output budget and the worker's remaining allowance. Failed
answers with reported usage consume it too. At the cap the worker stops asking
for jobs. Close and start a fresh worker to get a fresh allowance; `0` disables
serving. Without the cap environment variable Claude uses the plugin's
`sessionSummarizerMaxOutputTokens` (default 50000), and OMP uses 50000.

## Run replay

From another terminal, discover and replay historical transcripts:

```sh
lcm import --all --replay --parallel 4 --replay-provider session-pool
```

Or compact conversations already stored in lcm:

```sh
lcm compact --all --replay --parallel 4 --replay-provider session-pool
```

Set `--parallel` to the number of projects to process concurrently. It defaults
to 1 and does not parallelize sessions within one project. Each project's
previous-summary chain, manifest order and ledger remain serial. Several
workers can help only when several projects have work ready. Interrupting a
replay stops new work and lets in-flight work settle; rerunning resumes from its
ledger. `--restart` retains its existing reset behavior.

`--replay-provider` affects these replay requests only. Live compactions keep
`llm.provider`. A pool job that no worker claims within 20 s falls along the
chain; a claimed job has 3 minutes to be answered, because a replay chunk takes a
model longer than a claim. Late answers are discarded. Run at least as many
workers as `--parallel`, or claims wait on busy workers and fall back. Named configuration uses `llm.fallback`;
flat configuration uses `llm.fallbackProvider`, or `auto` when it is unset. To
fail an unavailable pool without invoking a process fallback, set the flat
`llm.fallbackProvider` to `disabled`, or leave the named fallback list empty.
See [configuration](configuration.md#summarize-worker-pool).

## Compare workers with endpoints

With the daemon and one or more workers running, evaluate a stored session:

```sh
lcm eval summarizer --session <id> --models session-pool,local --out ./comparison
```

`local` names an endpoint in `llm.providers`; `session-pool` needs no endpoint
entry. Evaluation sends isolated pool jobs through the authenticated daemon
route, keeping compaction in the eval process and the project database read-only.
Unlike replay, it never falls back: no claim within 20 s fails the pool candidate
with worker startup instructions, while other candidates complete. Claimed jobs
have 3 minutes to answer. Reports attribute usage to `session-pool:<model>`.
The live `session` provider is rejected. See
[compare summarizers](summarizer-compare.md) for report details.

## Transcript hygiene and hosts

Claude workers always call `$.model.complete`, including for condensed nodes.
They never call `fork`. The generated host API declares a tool-free completion
without session history. In Claude Code 2.1.285, the `model.complete` operation
dispatches to `cOe`, which sends a single supplied user message and system prompt
through the `TU` side-query helper. That helper returns the SDK response and
records request telemetry; it does not append transcript messages. No pool
prompt or reply is returned to a session hook as conversation context. This is
a versioned host implementation contract; regenerate `/plugin-types` and
inspect the completion operation when adopting a host build that changes it.

OMP's `pi-ai.complete` operates on the explicitly supplied messages and returns
an assistant message; its SDK has no session-manager writes. The worker never
uses `sendMessage` or `appendEntry`. OMP's
[custom compaction example](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/examples/hooks/custom-compaction.ts)
demonstrates credential resolution and this isolated completion API. Shutdown
aborts the worker's poll and completion.

Codex's [hooks contract](https://developers.openai.com/codex/hooks) exposes
command and MCP-tool handlers, without an isolated completion through the
interactive session's model client. There is therefore no Codex worker. Codex
transcripts can be replayed by either supported worker host.

The pool round-trip test uses the real provider, job store, routes and Claude
hook module with fake completions. It verifies concurrent claims, completion
only, and diagnostic writes without source content. Separate tests cover
OMP's isolated completion and the cap. Fakes establish lcm's behavior; the host
implementation evidence above establishes transcript persistence behavior.
