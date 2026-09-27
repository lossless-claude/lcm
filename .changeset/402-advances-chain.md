---
"@lossless-claude/lcm": patch
---

A summarizer endpoint that answers HTTP 402 (its account cannot pay, as OpenRouter does when the balance is exhausted) now hands the summary to the next endpoint in `llm.fallback` instead of failing the pass.
