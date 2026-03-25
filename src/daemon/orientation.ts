// Content written to ~/.claude/lcm.md during install/doctor — loaded via CLAUDE.md @include.
// Kept here as the single source of truth for the guidance text.
export const LCM_MD_CONTENT = `# lossless-claude memory — MANDATORY routing rules

Memory is captured automatically by hooks. Do NOT store manually.

## When to search

Search memory BEFORE asking the user about past decisions, architectural context, or anything that may have been discussed in a prior session.

## Tools

| Tool | Use for |
|------|---------|
| \`mcp__plugin_lcm_lcm__lcm_search\` | Broad conceptual recall — "how was X implemented", "decision about Y" |
| \`mcp__plugin_lcm_lcm__lcm_grep\` | Exact keyword, error message, function name |
| \`mcp__plugin_lcm_lcm__lcm_describe\` | Check metadata of a summary node before expanding |
| \`mcp__plugin_lcm_lcm__lcm_expand\` | Decompress a summary node for full content |

## Retrieval chain

\`\`\`
lcm_search "topic"        → broad matches, find nodeId
lcm_grep "exact term"     → narrow to specific references
lcm_describe <nodeId>     → check if worth expanding
lcm_expand <nodeId>       → full decompressed content
\`\`\`

## Storage

Storage is automatic — hooks capture sessions and compact them into memory. Never call \`lcm store\` or write to any memory system directly.
`;

// Guidance is now delivered via ~/.claude/lcm.md (installed by `lcm install` / `lcm doctor`),
// which CLAUDE.md includes via @lcm.md. No per-session injection needed.
export function buildOrientationPrompt(): string {
  return "";
}
