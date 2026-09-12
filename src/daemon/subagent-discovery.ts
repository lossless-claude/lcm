import { existsSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { claudeTranscriptPath } from "./project.js";
import { readSubagentAttribution, type SubagentAttribution } from "../subagent-attribution.js";

export interface DiscoveredSubagentSession extends SubagentAttribution {
  path: string;
  sessionId: string;
}

/**
 * Subagent transcripts for one already-known session, at
 * `<project>/<session_id>/subagents/*.jsonl`. Scoped to that single
 * directory: `/ingest` already knows which session it is processing, so this
 * costs one `existsSync` plus (only when the directory exists) one
 * `readdirSync` of it — never a walk of the whole projects tree.
 */
export function discoverSubagentSessions(cwd: string, sessionId: string): DiscoveredSubagentSession[] {
  const transcriptPath = claudeTranscriptPath(cwd, sessionId);
  if (!transcriptPath) return [];

  const subagentsDir = join(dirname(transcriptPath), sessionId, "subagents");
  if (!existsSync(subagentsDir)) return [];

  const found: DiscoveredSubagentSession[] = [];
  for (const entry of readdirSync(subagentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(subagentsDir, entry.name);
    found.push({ path, sessionId: basename(entry.name, ".jsonl"), ...readSubagentAttribution(path, sessionId) });
  }
  return found;
}
