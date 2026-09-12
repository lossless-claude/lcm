// src/hooks/learning-instruction.ts
//
// The standing instruction that tells the model when to call lcm_store. The command hook
// appends it to every prompt; the function-hooks module appends it once to the system
// prompt's `memory` section instead. hooks/lcm-hooks.ts carries a verbatim copy because the
// module cannot import from src/ — test/hooks/learning-instruction.test.ts keeps them equal.
export const LEARNING_INSTRUCTION = `<learning-instruction>
When you recognize a durable insight, call lcm_store immediately:
- decision: architectural/design choice with trade-offs
- preference: user working style or tool preference
- root-cause: bug cause that took effort to uncover
- pattern: codebase convention not documented elsewhere
- gotcha: non-obvious pitfall or footgun
- solution: non-trivial fix worth remembering
- workflow: multi-step process that works

Tag prefixes: type: | scope: | project: | source: | priority:
Usage: lcm_store(text: "concise insight with why", tags: ["type:decision", "project:<repo>"])

When you act on a surfaced memory (use it to inform a decision, avoid a known pitfall, or reference it in your work), emit:
lcm_store(text: "Acted on memory <id> — <one-line how>", tags: ["signal:memory_used", "memory_id:<id>"])
</learning-instruction>`;
