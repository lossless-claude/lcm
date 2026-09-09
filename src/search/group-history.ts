import { existsSync } from "node:fs";
import { closeLcmConnection } from "../db/connection.js";
import { projectDbPath } from "../daemon/project.js";
import { projectGroup, projectRef } from "../daemon/project-group.js";
import { openMigrated } from "./migrated-connection.js";
import { searchNativeHistory, type NativeHistoryHit } from "./native-history.js";

/**
 * Episodic history read across every checkout of one repository.
 *
 * Unlike promoted memory, which the design unions unconditionally, this is
 * gated: history is where the noise is, and a union multiplies the candidate
 * pool by the number of checkouts. `lcm bench run --union` measures the cost
 * against the same question sets, so the gate is opened on a number.
 */

/** Reciprocal-rank offset, matching the one used to fuse within a project. */
const FUSION_RANK_OFFSET = 10;

/**
 * Fuse per-database lists by reciprocal rank.
 *
 * Never by score: bm25 numbers from different databases rank the same text
 * differently because each database is its own corpus, so only positions are
 * comparable.
 */
function fuseByReciprocalRank(lists: NativeHistoryHit[][], limit: number): NativeHistoryHit[] {
  const scored = new Map<NativeHistoryHit, number>();
  for (const list of lists) {
    list.forEach((hit, position) => scored.set(hit, 1 / (FUSION_RANK_OFFSET + position)));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hit]) => hit);
}

/**
 * Searches episodic history across `cwd`'s group.
 *
 * A group of one takes the single-database path unchanged, so a project that
 * shares its repository with nothing keeps exactly the ranking it had.
 */
export async function searchHistoryGroup(
  cwd: string,
  input: { query: string; limit: number },
): Promise<NativeHistoryHit[]> {
  const lists: NativeHistoryHit[][] = [];

  for (const member of projectGroup(cwd)) {
    const dbPath = projectDbPath(member.cwd);
    if (!existsSync(dbPath)) continue;
    const db = openMigrated(dbPath);
    try {
      const found = await searchNativeHistory(db, {
        query: input.query,
        limit: input.limit,
        project: projectRef(member.cwd),
      });
      if (found.length > 0) lists.push(found);
    } finally {
      closeLcmConnection(dbPath);
    }
  }

  return lists.length <= 1
    ? (lists[0] ?? []).slice(0, input.limit)
    : fuseByReciprocalRank(lists, input.limit);
}
