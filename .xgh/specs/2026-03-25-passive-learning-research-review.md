# Research Review: Passive Learning Hooks Design

**Date:** 2026-03-25
**Reviewer:** Claude (research perspective)
**Spec reviewed:** `2026-03-25-passive-learning-hooks-design.md`
**Supporting doc:** `2026-03-25-confidence-decay-analysis.md`

---

## 1. Theoretical Grounding — Confidence Model

**Verdict: Well-grounded, with one important caveat.**

The spec's separation of confidence (quality/truth at write time), recency (temporal relevance at query time), and contradiction (staleness via semantic conflict) aligns closely with the state of the art. The seminal Generative Agents paper (Park et al., 2023, arXiv:2304.03442) established the canonical three-signal retrieval formula: recency (exponential decay), relevance (embedding similarity), and importance (self-assessed integer). Crucially, Park et al. apply recency at retrieval time, never mutating stored records — exactly what this spec does.

The Du 2026 survey ("Memory for Autonomous LLM Agents," arXiv:2603.07670) explicitly identifies the write-path design as a first-class engineering concern, listing _filtering_, _deduplication_, _priority scoring_, and _metadata tagging_ as essential components — all present in this spec.

**Caveat — the "no decay" claim overstates the Voltropy paper.** The confidence-decay analysis correctly identifies that the Voltropy LCM paper says nothing about confidence or decay. It is lossless-claude's own innovation. The spec should not cite "per the Voltropy LCM paper" when justifying the no-decay decision — it should own this as a principled design choice supported by the broader literature (Park et al., agent-memory, Du 2026). The theoretical support exists; it just does not come from Voltropy.

**MemoryBank counterpoint.** Zhong et al. (2024) applied Ebbinghaus forgetting curves to agent memory with some success for personal assistants. However, Du (2026, Section 6.1) notes this is most useful for conversational agents where "frequently accessed, high-importance memories are reinforced, while neglected ones fade." For a coding agent where decisions like "use SQLite not Postgres" remain indefinitely valid, Ebbinghaus decay is inappropriate. The spec's choice is correct for its domain.

---

## 2. Passive Capture Quality — Regex vs. Alternatives

**Verdict: Pragmatic choice, but the spec should acknowledge known limitations.**

The spec uses regex-based extraction from user prompts for decisions ("don't", "never", "always", "prefer"), roles ("act as", "senior engineer"), and intents ("why/explain" vs "create/fix"). This is a classic write-path filtering approach.

**What the literature says:**

- **ExpeL** (Zhao et al., 2024, arXiv:2312.17025 context; published ACL 2024) extracts "rules of thumb" by contrasting successful and failed trajectories using the LLM itself, not regex. This produces higher-quality extractions but costs LLM tokens per extraction.
- **Reflexion** (Shinn et al., 2023, arXiv:2303.11366) has the agent write natural language post-mortems after failures — entirely LLM-driven, zero regex. Achieved 91% pass@1 on HumanEval vs 80% for GPT-4 baseline.
- **agent-memory** (Martian Engineering) uses LLM-based fact extraction to decompose conversations into atomic facts, with entity resolution and relationship extraction.

**The trade-off is clear:** regex is zero-cost, deterministic, and fast (<5ms). LLM-based extraction is higher quality but adds latency and token cost per event. For a hook that runs on every tool call, regex is the right choice — but the spec should:

1. **Document the false-negative rate.** Decisions expressed indirectly ("that approach didn't work well for us last time") will be missed. The Du 2026 survey warns that "the optimal filtering threshold is application-specific" and recommends a risk analysis mapping failure modes to consequences.
2. **Consider a hybrid approach for Tier 1 events.** When AskUserQuestion fires (2-5 times per session), the user's answer could be classified by a small LLM call (Haiku, <100 tokens) rather than regex, since the frequency is low enough to absorb the cost.
3. **Add an escape hatch.** A pattern like `@remember: <text>` in user prompts would let users explicitly flag insights that regex misses, complementing the passive system.

---

## 3. Promotion Model — Three-Tier Priority

**Verdict: Solid architecture, but the confidence values need empirical calibration.**

The three-tier model (immediate for priority 1, batch for priority 2, pattern-only for priority 3) maps well to the Du 2026 survey's "Pattern B: Context + retrieval store" architecture, which is "the workhorse pattern behind most production agents today."

**Strengths:**
- The "flywheel" concept (passive capture seeds, explicit `lcm_store` confirms) is elegant. It creates a natural reinforcement loop where low-confidence passively captured insights get boosted when the LLM independently recognizes and stores the same insight.
- Tier 3's "only promote if already exists" rule is a good noise filter — it uses repetition as a quality signal.

**Concerns:**
- **The default confidence values (0.2-0.7) are arbitrary.** There is no published research establishing optimal confidence thresholds for tiered agent memory promotion. Du (2026) notes that "the write-path design should be informed by a risk analysis that maps memory failure modes to their downstream consequences." Recommendation: ship with the defaults but add telemetry to track promotion-to-surfacing rates and user override rates, then calibrate empirically.
- **Missing: importance scoring.** Park et al.'s three-signal formula includes importance as a self-assessed integer distinct from recency and relevance. The spec's confidence serves a similar purpose but conflates quality/truth with importance. A user's timezone preference and an architectural decision might both have high confidence, but the architectural decision is far more important. Consider adding an importance dimension separate from confidence.

---

## 4. Contradiction Detection

**Verdict: Known pattern, sensible implementation, but failure modes need mitigation.**

**What the literature supports:**
- Du (2026, Section 7.3) lists _contradiction detection_ as one of four essential mechanisms for robust memory systems, alongside temporal versioning, source attribution, and periodic consolidation.
- agent-memory (Martian Engineering) implements contradiction detection via LLM: when new facts are extracted, they're checked against existing facts for the same entity.
- The "source attribution" principle (user statement >> agent inference) is directly reflected in the spec's guard rail: "explicit `lcm_store` calls always reinforce, never supersede."

**Failure modes to document:**

1. **Pairwise comparison does not scale.** If the promoted store has N entries matching a BM25 query, the spec implies checking each for contradiction. At N=50, that's 50 Haiku calls. Add a hard cap (e.g., top 5 BM25 matches only).
2. **Self-reinforcing error** (Du 2026, Section 4.3): "If the agent incorrectly concludes 'API X always returns errors with parameter Y,' it will avoid that call path forever, never collecting evidence to overturn the false belief." The passive capture system could entrench a user's one-time frustrated comment ("never use library X") as a permanent preference. Mitigation: contradiction detection should also fire when an `lcm_store` call contradicts a passively captured entry, not just passive-vs-passive.
3. **The YES/NO prompt is fragile.** "Are these contradictory decisions about the same topic?" conflates two questions: (a) are they about the same topic? and (b) do they contradict? A "no" could mean either "different topics" or "same topic, consistent." Consider a two-step prompt or a three-way classification (CONTRADICT / SAME_TOPIC_CONSISTENT / DIFFERENT_TOPIC).
4. **BM25 threshold sensitivity.** The spec sets `contradictionBm25Threshold` at 20 (vs 15 for dedup). The gap between "these are duplicates" (15) and "these might contradict" (20) is narrow. Semantic contradictions often use different vocabulary ("use SQLite" vs "migrate to Postgres") and may score low on BM25. When embeddings become available (v2), this becomes much more reliable.

---

## 5. The Lossless Philosophy

**Verdict: Strongly supported by the literature. This is the right call.**

The "nothing is ever deleted, recency at query time" approach is validated by multiple systems:

- **agent-memory:** "Nothing is ever deleted. When facts change, the old fact is marked `historical` and the new one links back via `supersedes`."
- **Park et al. (2023):** The Generative Agents episodic stream is append-only. Reflections are additive layers, never deletions.
- **Du (2026):** Lists "learned forgetting" as an open challenge (Section 9), noting that AgeMem's RL-trained discard policy raises safety concerns: "Learned forgetting could delete safety-critical information."
- **The ResonantOS anecdote** in the confidence-decay analysis is a textbook case: a DNS deployment lesson from 3 weeks ago was more valuable with time, not less.

**One nuance the spec gets right:** archiving is not deletion. The `processed_at` cleanup (7 days for processed events in the sidecar) is appropriate because those events have already been promoted — the sidecar is a buffer, not a store. The promoted table is the lossless store.

**Counterargument to consider:** Du (2026) cites MemoryBank's Ebbinghaus-based decay as beneficial for personal assistants. The spec should explicitly scope its lossless claim: "lossless is correct for coding agent preferences and project decisions; conversational memory systems may benefit from decay." This prevents future contributors from cargo-culting "lossless" into domains where it's less appropriate.

---

## 6. Missing Opportunities

### 6a. Causal Retrieval (Du 2026, Section 9.2)

The most important gap. Du writes: "When an agent debugs a system failure, the relevant memory may be temporally distant and semantically dissimilar to the current error message yet causally upstream." The spec's error-fix pair correlation (Section 4, Event Correlation) is a primitive form of causal linking, but it only captures adjacent events. Consider annotating promoted entries with a `causal_parent` field — even approximate causal annotations generated at promotion time would improve debugging recall.

### 6b. Episodic-to-Semantic Consolidation

Du (2026, Section 3.1) identifies the episodic-to-semantic transition as a hard problem: "This consolidation is rarely automatic; most current systems require explicit prompting or heuristic triggers." The spec's Tier 2 batch promotion (aggregating git operations into session summaries) is a form of this, but it's limited to predefined categories. A more general consolidation pipeline — detecting repeated patterns across sessions and synthesizing them into semantic records — would be valuable for v2.

### 6c. Reflective Self-Improvement

Reflexion (Shinn et al., 2023) and ExpeL (Zhao et al., 2024) both demonstrate that agents improve dramatically when they reflect on failures. The spec captures error events but does not generate reflections from them. A natural extension: when the promotion pipeline detects an error-fix pair, have it generate a one-line lesson (via Haiku) rather than storing the raw error+fix. This is essentially what ExpeL's "rules of thumb" extraction does.

### 6d. Source Attribution Hierarchy

Du (2026, Section 7.3) emphasizes that "user statement >> agent inference" as a source hierarchy. The spec partially implements this (explicit `lcm_store` >> passive capture), but does not distinguish between:
- User typed it directly (highest signal)
- User answered an AskUserQuestion (high signal)
- Regex extracted it from user prompt context (medium signal)
- Inferred from tool call patterns (low signal)

A `source_strength` field on promoted entries would make retrieval scoring more nuanced.

### 6e. Evaluation Framework

Du (2026, Section 5.1) warns that "precision@k and nDCG tell you whether the right document was retrieved. They say nothing about whether the agent _used_ that document correctly." The spec has no evaluation plan beyond unit/integration tests. Consider:
- Tracking "insight surfaced -> user acted on it" vs "insight surfaced -> user ignored it"
- A/B testing confidence thresholds
- Measuring false positive rate (irrelevant insights surfaced) across real sessions

---

## Summary Assessment

| Criterion | Rating | Notes |
|-----------|--------|-------|
| Theoretical grounding | Strong | Aligns with Park et al., Du 2026, agent-memory. Minor attribution issue with Voltropy paper. |
| Passive capture quality | Good | Pragmatic regex choice for hot path. Should document false-negative trade-off. |
| Promotion model | Good | Three-tier is sound. Confidence values need empirical calibration. Missing importance dimension. |
| Contradiction detection | Adequate | Known pattern, but needs scaling cap, three-way classification, and cross-source contradiction. |
| Lossless philosophy | Strong | Well-supported by literature. Correct for coding agent domain. |
| Completeness | Good | Causal retrieval, reflective lessons, and source attribution hierarchy are the main gaps. |

**Overall:** This is a well-designed system that makes pragmatic engineering trade-offs. The core architecture (sidecar capture, tiered promotion, no-decay with query-time recency, contradiction-based archival) is consistent with the current research consensus. The main risks are in the details: regex extraction quality, arbitrary confidence defaults, and contradiction detection scalability. All are addressable through the recommended mitigations above.

---

## References

1. Park, J.S. et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior." arXiv:2304.03442. *Introduced recency+relevance+importance retrieval scoring; append-only episodic memory with reflective consolidation.*
2. Shinn, N. et al. (2023). "Reflexion: Language Agents with Verbal Reinforcement Learning." arXiv:2303.11366. *Verbal self-critiques as episodic memory; 91% HumanEval pass@1.*
3. Packer, C. et al. (2023). "MemGPT: Towards LLMs as Operating Systems." arXiv:2310.08560. *OS-inspired hierarchical memory tiers with interrupt-driven control flow.*
4. Sumers, T.R. et al. (2023). "Cognitive Architectures for Language Agents (CoALA)." arXiv:2309.02427. *Formalized modular memory components in language agent architecture.*
5. Zhang, Z. et al. (2024). "A Survey on the Memory Mechanism of Large Language Model based Agents." arXiv:2404.13501. *Comprehensive survey of memory design patterns.*
6. Zhao, A. et al. (2024). "ExpeL: LLM Agents Are Experiential Learners." *ACL 2024. Success/failure trajectory comparison for extracting reusable rules of thumb.*
7. Zhong, W. et al. (2024). "MemoryBank: Enhancing Large Language Models with Long-Term Memory." *Ebbinghaus forgetting curves for memory decay in personal assistants.*
8. Du, P. (2026). "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers." arXiv:2603.07670. *Most comprehensive survey to date; write-path filtering, contradiction handling, learned forgetting as open challenges.*
9. Yu et al. (2026). "Agentic Memory (AgeMem)." *RL-optimized memory operations (store/retrieve/update/summarize/discard).*
10. Martian Engineering. "agent-memory." github.com/Martian-Engineering/agent-memory. *Three-layer system (knowledge graph + daily notes + tacit knowledge) with contradiction detection and recency-scored retrieval.*
11. Ehrlich, C. & Blackman, T. "Voltropy LCM Paper." papers.voltropy.com/LCM. *Lossless context management via hierarchical DAG compaction; does NOT cover confidence/decay.*
