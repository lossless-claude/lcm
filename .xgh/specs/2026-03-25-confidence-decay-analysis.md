# Confidence & Decay Analysis: Voltropy Paper, lossless-claw, and agent-memory

**Date:** 2026-03-25
**Status:** Reference
**Context:** Research for passive learning hooks design (PostToolUse + enhanced UserPromptSubmit)

## Sources Consulted

1. **Voltropy LCM Paper** — [papers.voltropy.com/LCM](https://papers.voltropy.com/LCM) by Clint Ehrlich & Theodore Blackman
2. **lossless-claw** — [github.com/Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) (original fork source)
3. **agent-memory** — [github.com/Martian-Engineering/agent-memory](https://github.com/Martian-Engineering/agent-memory) (three-layer memory system)
4. **ResonantOS Substack** — [augmentedmind.substack.com](https://augmentedmind.substack.com/p/your-openclaw-forgot-everything-again) (practical deployment lessons)
5. **lossless-claude codebase** — `src/promotion/dedup.ts`, `src/daemon/config.ts`, `.xgh/specs/2026-03-23-llm-free-dedup-design.md`

## Key Finding: Voltropy Paper Has No Confidence or Decay Model

The LCM paper covers:
- **Lossless retrievability** via immutable store + hierarchical DAG
- **Three-level escalation** for compaction (async → blocking → deterministic fallback)
- **Zero-cost continuity** — model never needs to know compaction happened
- **Deterministic retrievability** — every message always reachable via `lcm_expand`/`lcm_grep`

The paper does NOT discuss:
- Confidence scoring
- Promotion to a semantic layer
- Time-based decay
- Cross-session memory

**The promoted store with confidence scoring is lossless-claude's own innovation** built on top of the LCM core.

## Historical Decision: confidenceDecayRate Was Intentionally Removed

In `src/daemon/config.ts` (line 86):
```typescript
delete thresholds["confidenceDecayRate"];
```

The LLM-free dedup design spec (`.xgh/specs/2026-03-23-llm-free-dedup-design.md`) explains why:

> "No confidence decay on merge: The current decay (`maxConfidence - confidenceDecayRate`) was designed for LLM merge quality uncertainty. Structural convergence doesn't degrade content, so decay is inappropriate."

The old `confidenceDecayRate` existed because LLM-based merges could degrade content quality. When dedup was rewritten to use structural convergence (BM25 + Math.max), decay became inappropriate because the content isn't transformed — it's preserved as-is.

## Existing Confidence Model in lossless-claude

### At Promotion Time (`src/promotion/detector.ts`)
```
confidence = Math.min(signals.size / 4, 1)
```
Signals: keyword matches, architecture patterns, depth threshold, compression ratio. More signals = higher confidence.

### On Dedup (`src/promotion/dedup.ts`)
```
refreshedConfidence = Math.max(confidence, ...duplicates.map(d => d.confidence))
```
Repeated sightings reinforce — confidence can only increase via Math.max. Weaker duplicates are archived (soft-deleted, recoverable).

### At Query Time (`src/daemon/routes/prompt-search.ts`)
```typescript
const recencyFactor = Math.pow(0.5, ageHours / halfLife);  // halfLife = 24h default
const sessionAffinity = (r.sessionId === session_id) ? 1.0 : crossSessionAffinity;  // 0.85 default
const score = Math.abs(r.rank) * recencyFactor * sessionAffinity;
```
Recency is ephemeral — applied at query time, never stored. Old entries naturally rank lower without being mutated.

## agent-memory's Approach (Martian Engineering)

### Recency at Retrieval Time
```
score = e^(-λ × days_old)    where λ = ln(2) / 30
```

| Age | Score |
|-----|-------|
| Today | 1.000 |
| 1 week | 0.871 |
| 30 days (half-life) | 0.500 |
| 90 days | 0.125 |

Key quote: "A fact from 3 months ago that was never contradicted should rank higher than a trivial fact from yesterday."

### Staleness via Contradiction Detection
- When new facts contradict existing ones, the old fact is marked superseded
- Time alone doesn't invalidate facts — only new contradicting evidence does

### Three-Layer Architecture
1. **Knowledge Graph** — atomic facts with entity relationships
2. **Daily Notes** — raw timeline, durable facts extracted to Layer 1
3. **Tacit Knowledge** — user preferences, work patterns (like lcm's promoted store)

## ResonantOS Deployment Lesson

Three weeks after a DNS deployment failure, the AI proactively recalled the lesson:

> "Before pushing, I need to check existing DNS records. Last time (March 21) we deployed without verifying DNS first — there was a stale A record pointing to old hosting that blocked HTTPS for 3 hours."

The value of this lesson did NOT decay over 3 weeks. It was more valuable with time, not less. Time-based decay would have weakened this recall.

## Conclusion: The Correct Model

| Signal | What it measures | When applied | Mutates storage? |
|--------|-----------------|-------------|-----------------|
| **Confidence** | Truth/quality of the insight | Set at promotion, reinforced by Math.max on duplicates | Only upward |
| **Recency** | Temporal relevance | Query time via exponential decay | No — ephemeral |
| **Contradiction** | Staleness/supersession | When new insight contradicts old one → archive old | Yes — archive (recoverable) |

### Rejected: Time-Based Confidence Decay
- `confidence *= 0.95` on session-start was proposed and rejected
- Violates lossless philosophy — mutates stored data based on time alone
- Valid insights ("use SQLite not Postgres") would lose confidence even though they're still true
- The correct mechanism is recency at query time (already implemented) + contradiction detection (to be added)

### Recommended for Passive Learning
- Events captured by PostToolUse go into sidecar (append-only)
- Promotion to promoted store uses confidence for quality/truth signal
- Retrieval uses existing recency scoring for temporal relevance
- **New: contradiction detection** — when a new promoted entry semantically contradicts an existing one, archive the old one
- Archive != delete — archived entries recoverable, excluded from active search
