import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectStats } from "../src/stats.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { writeHold } from "../src/daemon/hold.js";

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

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
  const stats = collectStats();
  expect(readFileSync(path)).toEqual(before);
  expect(stats.messages).toBe(current ? 1 : 0);
});
