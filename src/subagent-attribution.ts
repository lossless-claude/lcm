import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";

/**
 * What a subagent transcript's `.meta.json` sidecar can tell us about the
 * dispatch that created it. All three are null together: either the sidecar
 * is missing/unreadable, or the transcript is not a subagent transcript at
 * all (`discoverSubagentTranscripts` is the only reader).
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
function readSubagentAttribution(
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

export interface DiscoveredSubagentTranscript {
  path: string;
  /** Matches a `conversations.session_id` value (e.g. `agent-<id>`). */
  sessionId: string;
  mtime: number;
  attribution: SubagentAttribution;
}

/**
 * Every subagent transcript one session dispatched, with its attribution:
 * the only walker of `<sessionDir>/subagents/`, shared by `lcm import`, live
 * `/ingest` and the migration backfill so all three apply one rule.
 *
 * An `agent-<id>.jsonl` can sit directly under `subagents/` or nested
 * arbitrarily deeper — e.g. `subagents/workflows/wf_<id>/` for a workflow
 * run's own subagents — with the same format and the same sidecar at every
 * depth. Only `journal.jsonl` — a workflow run's own log, excluded by name,
 * not by shape — is not a transcript. Symlinks are skipped at every depth.
 * The owning session is `basename(sessionDir)` for every transcript found,
 * however deep; the directories in between are never a parent.
 */
export function discoverSubagentTranscripts(sessionDir: string): DiscoveredSubagentTranscript[] {
  const subagentsDir = join(sessionDir, "subagents");
  if (!existsSync(subagentsDir)) return [];
  const found: DiscoveredSubagentTranscript[] = [];
  walkSubagentDir(subagentsDir, basename(sessionDir), found);
  return found;
}

function walkSubagentDir(dir: string, folderSessionId: string, out: DiscoveredSubagentTranscript[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkSubagentDir(join(dir, entry.name), folderSessionId, out);
      continue;
    }
    const found = isSubagentTranscriptFile(entry) ? discoveredTranscript(join(dir, entry.name), folderSessionId) : null;
    if (found) out.push(found);
  }
}

function isSubagentTranscriptFile(entry: Dirent): boolean {
  return entry.isFile() && entry.name !== "journal.jsonl" && entry.name.endsWith(".jsonl");
}

function discoveredTranscript(path: string, folderSessionId: string): DiscoveredSubagentTranscript | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return null;
    return {
      path,
      sessionId: basename(path, ".jsonl"),
      mtime: st.mtimeMs,
      attribution: readSubagentAttribution(path, folderSessionId),
    };
  } catch {
    return null; // deleted between readdir and stat, or unreadable
  }
}

/**
 * `discoverSubagentTranscripts` over every `<project>/<session>/` directory
 * under a `~/.claude/projects`-shaped tree. Used by the one-time migration
 * backfill.
 */
export function walkSubagentTranscripts(claudeProjectsDir: string): DiscoveredSubagentTranscript[] {
  const entries: DiscoveredSubagentTranscript[] = [];
  if (!existsSync(claudeProjectsDir)) return entries;

  for (const projectEntry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    collectProjectSubagentTranscripts(join(claudeProjectsDir, projectEntry.name), entries);
  }

  return entries;
}

function collectProjectSubagentTranscripts(projectDir: string, out: DiscoveredSubagentTranscript[]): void {
  for (const sessionEntry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!sessionEntry.isDirectory()) continue;
    out.push(...discoverSubagentTranscripts(join(projectDir, sessionEntry.name)));
  }
}
