# Decision detection: what a calibrated classifier can and cannot do

**Status:** evaluated, 2026-09-27. Decided in #581: the `user_decision` event is removed.

The passive `user_decision` event (`src/hooks/extractors.ts`, `decisionPatterns`) was a
bounded judgment: does this user turn state a decision, rule or preference that should keep
applying after the request? We measured it, a pt-BR keyword list and two external decision
models on the same turns. The shipped detector found none of the decisions in pt-BR. A
calibrated classifier ranks turns well, but its confident answers are not reliable enough to
promote anything on their own. The category itself needs a definition first; round 2 below
tests one, and two independent annotators apply it consistently.

This evaluation justifies two constraints. `extractUserPromptEvents` no longer emits
`user_decision`: it was promoted at priority 1 with the `decision` confidence, and no detector
met the round-2 definition well enough to be a promotion signal. Decisions from
`AskUserQuestion` are unaffected; the answer there is the decision. And a classifier's answer
should only ever route a turn to review (see Constraints on any integration); lcm has no review
surface yet, so a classifier is not integrated.

## Corpus and labels

The corpus is `pt-coding-turns-2026-09`, kept outside the repository because it holds a
person's prompts: 1,967 turns one pt-BR author typed in coding sessions, each passed through
`ScrubEngine` (a turn the scrubber changed was left out). 1,448 of them pass the sampling
filters (15 to 1,200 characters, no pasted tool output). Round 1 and round 2 draw from those
1,448 without overlap.

- Round 1: 234 turns across 15 projects: 200 drawn at random, 34 more flagged by either
  keyword list.
- Every annotator used four labels: yes, no, undecidable, and not typed by a person.
- The author labeled all 234 turns before any model ran. Two LLM annotators (Claude Fable 5.1,
  GPT-6 Astra) labeled the same 234 blind. The 52 disagreements are the turns where the three
  did not all give the same label; the author adjudicated them, seeing the annotators'
  answers but no model output.
- Only turns whose final label is yes or no are scored; the exclusion is applied after
  adjudication and before scoring. Final labels: 11 yes, 185 no, 4 undecidable, 34 not typed
  by a person, so 196 turns are evaluated. In the random stratum, 176 of the 200 remain, 4 of
  them decisions (about 2%). The author's first pass had 24 yes, 175 no, 2 undecidable and 33
  not typed by a person, so the first-pass scores use 199 turns.
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

1. **The shipped detector was English-only.** It found 0 of 11 decisions in pt-BR. A second
   keyword list is not the fix: on the random stratum it found none.
2. **"Lasting decision" is not yet a category two readers apply the same way.** Before
   adjudication, the author and the two annotators agreed at κ 0.32 on it, while the
   annotators agreed with each other at 0.74. The contested turns are mixed: a lasting
   preference stated inside a one-off request. Jev's most confident misses are these same
   turns. A detector needs a definition that says how they count.
3. **A calibrated classifier is a review queue, not a promoter.** Jev ranks well, but a high
   probability did not mean a decision: none of its answers at P ≥ 0.9 in the random stratum
   was a decision, under either label set. At 0.5 it flags 17 of the 176 random turns
   (about 10%, 4 of them decisions) and 30 of the 196 evaluated turns (11 of them decisions).
4. **Its score depends on the labels more than on the model.** On the evaluated set, Jev's
   AUROC was 0.83 against the author's first pass (199 turns) and 0.977 against the
   adjudicated labels (196 turns); on the random stratum, 0.79 and 0.97. The model's answers
   were identical in both.
5. **A small open decision model does not work zero-shot here.** Laya says yes to almost
   every turn. It would need fine-tuning on far more positives than one corpus provides.
6. **Jev is stable, and insensitive to the language of the question.** Across three identical
   runs, the answer flipped on 3 of 196 turns, and no probability moved more than 0.10. Asking
   the question in English or in Portuguese about the same pt-BR turns made no difference;
   other input languages were not tested.

## Round 2: a written definition, two LLM annotators, no human

The second draw tests a written definition, anchored to the `type:decision` and
`type:preference` rows of `docs/tag-schema.md`:

> Does any part of this turn state a decision or preference that keeps applying in future
> sessions? Yes: an architecture or process decision (what was chosen), or a preference about
> how things should be done ("always X", "never Y", "I prefer Z"), that would still hold in a
> future session — even when the rest of the turn is a one-off request. No: everything in it
> applies to this task only (a request, a question, a report, an answer to the agent, a
> one-off instruction).

- 400 turns drawn at random from the 1,214 filtered turns round 1 did not use, no keyword
  stratum. The definition, the question text and the sample were frozen before any label.
- Fable and Astra labeled all 400 blind with that definition and the same four labels as
  round 1 (yes, no, undecidable, not typed by a person); no human labeled this round.
  The same definition, word for word, is Jev's question.
- Gold is the 349 turns where both said yes (22, about 6%) or both said no (327). The other
  51 are out of gold: 30 both "not typed by a person", 1 both "undecidable", 13 where only
  one said yes, and 7 where they disagreed without either saying yes.

The two annotators agreed at κ 0.75 on yes against the rest (0.83 across the four labels),
which meets the bar #581 set.

| Detector | Flagged | Correct | Precision | Recall | AUROC |
| --- | --- | --- | --- | --- | --- |
| `decisionPatterns` (shipped) | 0 | 0 | — | 0 of 22 | — |
| pt-BR keyword list | 0 | 0 | — | 0 of 22 | — |
| Jev 1.13.0, hosted | 29 | 15 | 0.52 | 15 of 22 | 0.956 |

- The keyword lists found nothing: under the new definition, decisions are rarely phrased with
  "always" or "never". Jev's seven misses are design decisions stated as instructions (a
  default value, a removed process step), at P 0.26 to 0.43.
- High confidence now means something: at P ≥ 0.8, 4 of 5 flags are decisions.
- Jev is uncertain where the annotators disagree: on the 13 turns where only one of them said
  yes, its P ranged from 0.16 to 0.69, all but one between 0.40 and 0.69.
- With each annotator alone as gold, Jev's AUROC is 0.957 (Fable) and 0.937 (Astra).
- Exploratory, not pre-registered: at 0.25 Jev catches all 22 and flags 88 of 349 turns; at
  0.4, 18 of 22 with 39 flags.

The definition is usable: two independent readers apply it consistently. This round cannot
confirm the round-1 score the way a human label would, because every label is an LLM reading
of the same text Jev reads, and consensus gold leaves out the 13 contested turns.

## Constraints on any integration

- A hosted classifier sends the turn text off the machine. It is opt-in, and it only receives
  text that has already passed through `ScrubEngine`. The hooks that see a prompt first
  (`UserPromptSubmit`, `PostToolUse`) hold it unscrubbed.
- Its output is a routing signal: surface for review, never promote or discard on its own. The
  record stays lossless whatever the classifier says.

## Limits of this evidence

One author, one language, 11 decisions in round 1 and 22 in round 2. Recall of 11 of 11 has a 95% interval of roughly
0.72 to 1.0. The adjudicated labels were shaped by two LLM annotators whose reading of the
question matched Jev's. Laya ran on Apple MPS; the ONNX CPU path was not measured. A local
drop-in for the hosted API (Kev) was not tested.
