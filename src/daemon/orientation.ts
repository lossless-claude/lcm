// Content written to ~/.claude/lcm.md during install/doctor — loaded via CLAUDE.md @include.
// Kept here as the single source of truth for the guidance text.
export const LCM_MD_CONTENT = `# lossless-claude memory — MANDATORY routing rules

Memory is captured automatically by hooks. Do NOT store manually.

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

Memory is captured automatically by hooks. Do NOT store manually via \`lcm store\` CLI — use the MCP tools (\`lcm_store\`) only when explicitly needed.
`;

// Guidance is now delivered via ~/.claude/lcm.md (installed by `lcm install` / `lcm doctor`),
// which CLAUDE.md includes via @lcm.md. No per-session injection needed.
export function buildOrientationPrompt(): string {
  return "";
}
