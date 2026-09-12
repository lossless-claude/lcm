// The storing rule's leading phrase. Every guidance surface states it, then names its own tool;
// tests import it instead of duplicating the wording.
export const STORE_RULE_PHRASE = "Store durable insights";

// Content written to ~/.claude/lcm.md during install/doctor — loaded via CLAUDE.md @include.
// Kept here as the single source of truth for the guidance text.
export const LCM_MD_CONTENT = `# lossless-claude memory — MANDATORY routing rules

Hooks capture sessions automatically.

## When to search

Search memory BEFORE asking the user about past decisions, architectural context, or anything that may have been discussed in a prior session.

## Tools

| Tool | Use for |
|------|---------|
| \`lcm_search\` | Broad conceptual recall — "how was X implemented", "decision about Y" |
| \`lcm_grep\` | Exact keyword, error message, function name |
| \`lcm_describe\` | Check metadata of a summary node before expanding |
| \`lcm_expand\` | Decompress a summary node for full content |

## Retrieval chain

\`\`\`
lcm_search "topic"        → broad matches, find nodeId
lcm_grep "exact term"     → narrow to specific references
lcm_describe <nodeId>     → check if worth expanding
lcm_expand <nodeId>       → full decompressed content
\`\`\`

## Storage

${STORE_RULE_PHRASE} (decision, preference, root-cause, pattern, gotcha, solution, workflow) explicitly with \`lcm_store\` (MCP) or \`lcm store\` (CLI), tagged with \`type:\`. One concise insight and its why per store.
`;

// Guidance is now delivered via ~/.claude/lcm.md (installed by `lcm install` / `lcm doctor`),
// which CLAUDE.md includes via @lcm.md. No per-session injection needed.
export function buildOrientationPrompt(): string {
  return "";
}
