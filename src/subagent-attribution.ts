import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";

/**
 * What a subagent transcript's `.meta.json` sidecar can tell us about the
 * dispatch that created it. All three are null together: either the sidecar
 * is missing/unreadable, or the transcript is not a subagent transcript at
 * all (findSessionFiles never calls this for flat/nested session files).
 */
export interface SubagentAttribution {
  parentSessionId: string | null;
  subagentType: string | null;
  subagentDesc: string | null;
}

const EMPTY_ATTRIBUTION: SubagentAttribution = {
  parentSessionId: null,
  subagentType: null,
  subagentDesc: null,
};

/**
 * Reads the `.meta.json` sidecar next to a subagent transcript.
 *
 * `folderSessionId` is the session that owns the `subagents/` directory the
 * transcript lives in — the parent for the common case (no `parentAgentId`
 * in the sidecar). When the sidecar does carry `parentAgentId` (a nested
 * dispatch), the immediate dispatcher is a sibling `agent-<id>.jsonl` in the
 * same directory, not the owning session, so the id is prefixed with
 * `agent-` to match that sibling's own `session_id`.
 *
 * A missing, unreadable, or invalid sidecar yields all three fields null —
 * not an error, and no fallback to the folder name.
 */
export function readSubagentAttribution(
  transcriptPath: string,
  folderSessionId: string,
): SubagentAttribution {
  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return EMPTY_ATTRIBUTION;

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return EMPTY_ATTRIBUTION;
  }

  const parentAgentId = typeof meta.parentAgentId === "string" && meta.parentAgentId ? meta.parentAgentId : null;
  return {
    parentSessionId: parentAgentId ? `agent-${parentAgentId}` : folderSessionId,
    subagentType: typeof meta.agentType === "string" ? meta.agentType : null,
    subagentDesc: typeof meta.description === "string" ? meta.description : null,
  };
}

export interface SubagentTranscriptEntry {
  /** Matches a `conversations.session_id` value (e.g. `agent-<id>`). */
  sessionId: string;
  attribution: SubagentAttribution;
}

/**
 * Walks every `<project>/<session>/subagents/*.jsonl` transcript under a
 * `~/.claude/projects`-shaped directory, reading each one's sidecar. Used by
 * the one-time migration backfill — `findSessionFiles` in `import.ts` reads
 * sidecars inline during its own walk instead of calling this.
 */
export function walkSubagentTranscripts(claudeProjectsDir: string): SubagentTranscriptEntry[] {
  const entries: SubagentTranscriptEntry[] = [];
  if (!existsSync(claudeProjectsDir)) return entries;

  for (const projectEntry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    collectProjectSubagentTranscripts(join(claudeProjectsDir, projectEntry.name), entries);
  }

  return entries;
}

function collectProjectSubagentTranscripts(projectDir: string, out: SubagentTranscriptEntry[]): void {
  for (const sessionEntry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!sessionEntry.isDirectory()) continue;
    collectSubagentTranscripts(projectDir, sessionEntry.name, out);
  }
}

function collectSubagentTranscripts(
  projectDir: string,
  folderSessionId: string,
  out: SubagentTranscriptEntry[],
): void {
  const subagentsDir = join(projectDir, folderSessionId, "subagents");
  if (!existsSync(subagentsDir)) return;

  for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
    if (!isSubagentTranscriptFile(sub)) continue;
    const transcriptPath = join(subagentsDir, sub.name);
    out.push({
      sessionId: basename(sub.name, ".jsonl"),
      attribution: readSubagentAttribution(transcriptPath, folderSessionId),
    });
  }
}

function isSubagentTranscriptFile(entry: Dirent): boolean {
  return entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl");
}
