import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectLegacyUsageByGroups, collectStats } from "../src/stats.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { writeHold } from "../src/daemon/hold.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { PromotedStore } from "../src/db/promoted.js";

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it("bounds legacy prepass handles to one group and continues after an open failure", () => {
  root = mkdtempSync(join(tmpdir(), "lcm-legacy-groups-"));
  const paths = ["bad", "owner", "requester", "later"];
  const dbs = new Map<string, DatabaseSync>();
  for (const id of paths) {
    const db = new DatabaseSync(join(root, `${id}.sqlite`));
    runLcmMigrations(db);
    dbs.set(id, db);
  }
  const memoryId = new PromotedStore(dbs.get("owner")!).insert({ content: "owner", tags: [], projectId: "p" });
  new PromotedStore(dbs.get("requester")!).insert({ content: "use", tags: ["signal:memory_used", `memory_id:${memoryId}`], projectId: "p" });
  let open = 0;
  let peak = 0;
  try {
    const counts = collectLegacyUsageByGroups([["bad"], ["owner", "requester"], ["later"]], (id) => {
      if (id === "bad") throw new Error("open failed");
      open++; peak = Math.max(peak, open);
      return dbs.get(id)!;
    }, () => { open--; });
    expect(peak).toBe(2);
    expect(counts.byOwner.get("owner")?.get(memoryId)).toBe(1);
  } finally {
    for (const db of dbs.values()) db.close();
  }
});

it.each([false, true])("stats during a hold never migrates or writes project databases (current schema: %s)", async (current) => {
  root = mkdtempSync(join(tmpdir(), "lcm-readonly-stats-"));
  vi.stubEnv("LCM_HOME", root);
  const project = join(root, "projects", "fixture");
  mkdirSync(project, { recursive: true });
  const path = join(project, "db.sqlite");
  const db = new DatabaseSync(path);
  if (current) {
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("readonly-session");
    await store.createMessagesBulk([{ conversationId: conversation.conversationId, seq: 0, role: "user", content: "stored", tokenCount: 1 }]);
  } else {
    db.exec("CREATE TABLE maintenance_marker (value TEXT); INSERT INTO maintenance_marker VALUES ('in-progress')");
  }
  db.close();
  writeHold(join(root, "daemon.pid"));
  const before = readFileSync(path);
  const stats = collectStats(createLcmPaths(root));
  expect(readFileSync(path)).toEqual(before);
  expect(stats.messages).toBe(current ? 1 : 0);
});

it.each([false, true])("keeps legacy project counts when optional metrics are absent (partial usage: %s)", (usage) => {
  root = mkdtempSync(join(tmpdir(), "lcm-legacy-stats-"));
  vi.stubEnv("LCM_HOME", root);
  const project = join(root, "projects", "legacy");
  mkdirSync(project, { recursive: true });
  const path = join(project, "db.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE conversations (conversation_id INTEGER);
    CREATE TABLE messages (conversation_id INTEGER, token_count INTEGER);
    CREATE TABLE summaries (conversation_id INTEGER, token_count INTEGER);
    INSERT INTO conversations VALUES (1);
    INSERT INTO messages VALUES (1, 40);
    INSERT INTO summaries VALUES (1, 10);
  `);
  if (usage) db.exec("CREATE TABLE llm_usage_stats (calls_total INTEGER); INSERT INTO llm_usage_stats VALUES (3)");
  db.close();
  const before = readFileSync(path);
  const stats = collectStats(createLcmPaths(root));
  expect(stats).toMatchObject({ projects: 1, conversations: 1, messages: 1, summaries: 1, rawTokens: 40, summaryTokens: 10, maxDepth: 0 });
  expect(stats.llmUsage).toMatchObject({ calls: usage ? 3 : 0, costUsd: null });
  expect(readFileSync(path)).toEqual(before);
});
