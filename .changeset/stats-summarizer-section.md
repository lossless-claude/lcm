---
"@lossless-claude/lcm": patch
---

Show summarizer usage in `lcm stats`. The figures were already collected and stored but never rendered; a Summarizer section now reports calls, the token breakdown and the cost, appearing only once a call has been recorded. Cost follows the same rule as the replay receipt: `unknown` rather than `$0.00` when nothing reported a price, six decimals below a dollar, and "N of M calls priced" so a partial total cannot pass for a complete one.
