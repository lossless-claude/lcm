---
"@lossless-claude/lcm": patch
---

Report token usage from the HTTP summarizer providers. `openai` and `anthropic` now emit the same normalized accounting the process-backed providers do, so `llm_usage_stats` and `lcm import --replay` stop showing a summarizer that appears to consume nothing. Against an OpenRouter base URL the `openai` provider asks for cost accounting and records the real charge; every other server leaves `costUsd` absent, meaning unknown, never free.
