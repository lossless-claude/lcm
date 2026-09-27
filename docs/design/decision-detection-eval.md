# Decision detection: what a calibrated classifier can and cannot do

**Status:** evaluated, 2026-09-27. Scopes #581; no code change is made by this document.

The passive `user_decision` event (`src/hooks/extractors.ts`, `decisionPatterns`) is a
bounded judgment: does this user turn state a decision, rule or preference that should keep
applying after the request? We measured it, a pt-BR keyword list and two external decision
models on the same turns. The shipped detector finds none of the decisions in pt-BR. A
calibrated classifier ranks turns well, but its confident answers are not reliable enough to
promote anything on their own. The category itself needs a definition first.

## Corpus and labels

- 234 turns one pt-BR author typed in coding sessions across 15 projects: 200 drawn at
  random, 34 more flagged by either keyword list. Every turn passed through `ScrubEngine`;
  a turn the scrubber changed was left out.
- The author labeled every turn before any model ran. Two LLM annotators (Claude Fable 5.1,
  GPT-6 Astra) labeled the same turns blind. The author adjudicated the 52 disagreements,
  seeing the annotators' answers but no model output.
- Evaluated: 196 turns, 11 of them decisions. In the random stratum, 4 of 176 (about 2%).
- One question for every model, the same text in each: a yes/no (`noul`) asking whether the
  turn states a lasting decision, rule or preference. Decision threshold fixed at 0.5 before
  any result.

## Results

All models scored the same 196 turns. The keyword rows are inflated here, because the 34
extra turns were chosen by them.

| Detector | Precision | Recall | AUROC | ECE | p50 latency |
| --- | --- | --- | --- | --- | --- |
| `decisionPatterns` (shipped) | 0 | 0 of 11 | — | — | — |
| pt-BR keyword list | 0.29 | 7 of 11 | — | — | — |
| Jev 1.13.0, hosted | 0.37 | 11 of 11 | 0.977 | 0.18 | 231 ms |
| Laya multilingual, local, zero-shot | 0.07 | 11 of 11 | 0.73 | 0.66 | 25 ms |
| Laya English, local, zero-shot | 0.05 | 10 of 11 | 0.24 | 0.58 | 64 ms |

In the random stratum, Jev flagged 17 of 176 turns and all 4 decisions were among them. The
pt-BR keyword list flagged 7 there, none of them a decision.

## What this establishes

1. **The shipped detector is English-only.** It finds 0 of 11 decisions in pt-BR. A second
   keyword list is not the fix: on the random stratum it found none.
2. **"Lasting decision" is not yet a category two readers apply the same way.** Before
   adjudication, the author and the two annotators agreed at κ 0.32 on it, while the
   annotators agreed with each other at 0.74. The contested turns are mixed: a lasting
   preference stated inside a one-off request. Jev's most confident misses are these same
   turns. A detector needs a definition that says how they count.
3. **A calibrated classifier is a review queue, not a promoter.** Jev ranks well, but a high
   probability did not mean a decision: none of its answers at P ≥ 0.9 in the random stratum
   was a decision, under either label set. At 0.5 it flags about 10% of turns, and one flag in three or
   four is a decision.
4. **Its score depends on the labels more than on the model.** On the evaluated set, Jev's
   AUROC was 0.83 against the author's first pass (199 turns) and 0.977 against the
   adjudicated labels (196 turns); on the random stratum, 0.79 and 0.97. The model's answers
   were identical in both.
5. **A small open decision model does not work zero-shot here.** Laya says yes to almost
   every turn. It would need fine-tuning on far more positives than one corpus provides.
6. **Jev is stable and language-neutral on this task.** Across three identical runs, the answer
   flipped on 3 of 196 turns, and no probability moved more than 0.10. Asking the question in English
   or in Portuguese made no difference.

## Constraints on any integration

- A hosted classifier sends the turn text off the machine. It is opt-in, and it only receives
  text that has already passed through `ScrubEngine`. The hooks that see a prompt first
  (`UserPromptSubmit`, `PostToolUse`) hold it unscrubbed.
- Its output is a routing signal: surface for review, never promote or discard on its own. The
  record stays lossless whatever the classifier says.

## Limits of this evidence

One author, one language and 11 decisions. Recall of 11 of 11 has a 95% interval of roughly
0.72 to 1.0. The adjudicated labels were shaped by two LLM annotators whose reading of the
question matched Jev's. Laya ran on Apple MPS; the ONNX CPU path was not measured. A local
drop-in for the hosted API (Kev) was not tested.
