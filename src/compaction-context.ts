/** Reserved envelope for generated context, never an episodic source message. */
export const COMPACTION_CONTEXT_OPEN = '<lcm-compaction-context version="1">';
export const COMPACTION_CONTEXT_CLOSE = "</lcm-compaction-context>";

export function wrapCompactionContext(fencedContext: string): string {
  return `${COMPACTION_CONTEXT_OPEN}\n${fencedContext}\n${COMPACTION_CONTEXT_CLOSE}`;
}

export function isCompactionContext(text: string): boolean {
  return text.startsWith(`${COMPACTION_CONTEXT_OPEN}\n<recent-session-context>\n`)
    && text.endsWith(`\n</recent-session-context>\n${COMPACTION_CONTEXT_CLOSE}`);
}
