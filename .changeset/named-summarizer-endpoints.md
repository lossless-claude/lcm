---
"@lossless-claude/lcm": minor
---

Several summarizer endpoints can be configured at once. `llm.providers` names each endpoint with its own `type`, `model`, `baseURL`, `apiKey` (`${ENV}` expansion; an unset variable fails config load) and `body`; `llm.provider` picks the first and `llm.fallback` lists the others in order, so the DeepSeek API and OpenRouter can be configured side by side, after the session provider or without it. The flat `llm.*` form keeps working unchanged.

A `body` holds extra request fields for the vendor's own switches — `thinking: {type: "disabled"}` for the DeepSeek API, `reasoning` for OpenRouter, `chat_template_kwargs: {enable_thinking: false}` for Qwen behind an OpenAI-compatible server. Config load rejects a body that is not a JSON object, holds a prototype key, or sets a field lcm generates (`model`, `messages`, `max_tokens`, `stream`, …).

The chain moves to the next endpoint after a session that did not answer, a cut-off or empty answer, a refused key (401/403), or an endpoint still unavailable after its retries; a 400/422 or an unrecognised error fails the pass instead. Each endpoint runs once per summarization, and its usage is recorded under its own name: a DeepSeek answer that was cut off counts as a failed `deepseek` call even when OpenRouter's answer is stored. When every endpoint fails, the pass fails with one error naming each failure. The `openai` and `anthropic` providers no longer retry a 4xx other than 408 and 429.
