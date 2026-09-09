import { existsSync } from "node:fs";
import { closeLcmConnection } from "../db/connection.js";
import { PromotedStore, type SearchResult } from "../db/promoted.js";
import { RecallStore, type RecallFeedback } from "../db/recall.js";
import { projectDbPath } from "../daemon/project.js";
import { projectGroup, projectRef } from "../daemon/project-group.js";
import { openMigrated } from "./migrated-connection.js";
import type { ProjectRef } from "./native-history.js";

/**
 * Promoted memory read across every checkout of one repository.
 *
 * Storage stays per-cwd, so the same repository checked out twice holds two
 * sets of promoted memories. Recall unions them at read time. A physical merge
 * was rejected: bm25 scores from different databases are not comparable, so
 * results are fused by reciprocal rank instead.
 */

export type GroupPromotedHit = SearchResult & { project: ProjectRef };

/**
 * Reciprocal-rank offset. Large enough that a top hit in a small database does
 * not automatically outrank a strong hit further down a large one.
 */
const FUSION_RANK_OFFSET = 10;

export interface GroupPromotedSearch {
  hits: GroupPromotedHit[];
  /** Recall feedback for every hit, read from the database that holds it. */
  feedback: Map<string, RecallFeedback>;
}

/**
 * Fuses per-database result lists into one.
 *
 * Order comes from reciprocal rank. The `rank` field then gets re-drawn from
 * the magnitudes the members actually produced, largest first: downstream
 * scoring multiplies `rank` and compares the product against a configured
 * threshold, so the union has to land on the same scale the single-project
 * path does or that threshold changes meaning.
 */
function fuseByReciprocalRank(lists: GroupPromotedHit[][], limit: number): GroupPromotedHit[] {
  const scored = new Map<GroupPromotedHit, number>();
  for (const list of lists) {
    list.forEach((hit, position) => scored.set(hit, 1 / (FUSION_RANK_OFFSET + position)));
  }
  const ordered = [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hit]) => hit)
    .slice(0, limit);

  const magnitudes = [...scored.keys()]
    .map(hit => Math.abs(hit.rank))
    .sort((a, b) => b - a);
  return ordered.map((hit, position) => ({ ...hit, rank: magnitudes[position] ?? hit.rank }));
}

interface GroupSearchInput {
  query: string;
  limit: number;
  tags?: string[];
  /** Read recall feedback alongside the hits. Only the prompt hook needs it. */
  withFeedback?: boolean;
}

/**
 * Searches promoted memory across `cwd`'s group.
 *
 * A group of one takes the single-database path unchanged, so a project that
 * shares its repository with nothing keeps exactly the ranking it had.
 */
export function searchPromotedGroup(cwd: string, input: GroupSearchInput): GroupPromotedSearch {
  const members = projectGroup(cwd);
  const lists: GroupPromotedHit[][] = [];
  const feedback = new Map<string, RecallFeedback>();

  for (const member of members) {
    const dbPath = projectDbPath(member.cwd);
    if (!existsSync(dbPath)) continue;
    const db = openMigrated(dbPath);
    try {
      const found = new PromotedStore(db).search(input.query, input.limit, input.tags);
      if (found.length === 0) continue;
      lists.push(found.map(result => ({ ...result, project: projectRef(member.cwd) })));
      if (input.withFeedback) {
        for (const [id, entry] of new RecallStore(db).getFeedback(found.map(r => r.id))) {
          feedback.set(id, entry);
        }
      }
    } finally {
      closeLcmConnection(dbPath);
    }
  }

  const hits = lists.length <= 1
    ? (lists[0] ?? []).slice(0, input.limit)
    : fuseByReciprocalRank(lists, input.limit);
  return { hits, feedback };
}

/**
 * Records which memories were surfaced, each in the database that holds it.
 *
 * Surfacing drives the cooldown that keeps the same memory from being injected
 * every prompt. Writing it all to the requesting project would split that state
 * from the memory it describes, and the sibling would go on resurfacing.
 */
export function logGroupSurfacing(
  hits: GroupPromotedHit[],
  surfacedIds: string[],
  sessionId: string | null,
): void {
  const surfaced = new Set(surfacedIds);
  const byProject = new Map<string, string[]>();
  for (const hit of hits) {
    if (!surfaced.has(hit.id)) continue;
    const ids = byProject.get(hit.project.cwd) ?? [];
    ids.push(hit.id);
    byProject.set(hit.project.cwd, ids);
  }

  for (const [memberCwd, ids] of byProject) {
    const dbPath = projectDbPath(memberCwd);
    if (!existsSync(dbPath)) continue;
    const db = openMigrated(dbPath);
    try {
      new RecallStore(db).logSurfacing(ids, sessionId);
    } finally {
      closeLcmConnection(dbPath);
    }
  }
}
