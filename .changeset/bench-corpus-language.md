---
"@lossless-claude/lcm": patch
---

Write `lcm bench build --generator llm` questions in the language the corpus's author asks in. The generator paraphrased whatever prompt it was handed, so questions inherited the prompt's language: 58 of 60 generated questions came out English against 11 of 13 hand-written ones in pt-BR, because the sampled prompts are mostly pasted code and tool output. Such a set measures same-language paraphrase recall, a task the person never performs. The language is now read once per build from a sample of the corpus's human turns, recorded on the file as `language`, printed by `run`, and overridable with `--language` (`LCM_BENCH_LANGUAGE` in the corpora harness); a build that cannot tell fails instead of defaulting to English. The corpora harness builds with the LLM generator, since mechanical templates are English by construction.
