import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { runLcmMigrations } from "../../src/db/migration.js";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../../src/daemon/project.js", () => ({
  projectDir: () => join(state.root, "index"),
  projectDbPath: () => join(state.root, "source.sqlite"),
  projectId: () => "sdk-project",
}));
import { qmdPaths, syncProjection, resolveProjectedHits } from "../../src/search/qmd-projection.js";

let db: DatabaseSync;
let sdk: QMDStore | undefined;
afterEach(async () => {
  await sdk?.close();
  sdk = undefined;
  db?.close();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});

it("indexes and searches real QMD evidence without models, then rejects stale source hits", async () => {
  state.root = mkdtempSync(join(tmpdir(), "lcm-qmd-sdk-"));
  db = new DatabaseSync(join(state.root, "source.sqlite"));
  runLcmMigrations(db);
  db.exec("INSERT INTO conversations(session_id) VALUES ('sdk-session')");
  const text = "Azulejo: decisão de manter a fonte SQLite com índice derivado.";
  const insert = db.prepare("INSERT INTO messages(conversation_id,seq,role,content,token_count) VALUES (1,?,'user',?,20)");
  insert.run(1, text);
  insert.run(2, text);
  syncProjection("project");
  const paths = qmdPaths("project");
  mkdirSync(paths.root, { recursive: true });
  sdk = await createStore({ dbPath: paths.dbPath, config: {
    collections: { lcm: { path: paths.documentsPath, pattern: "**/*.md" } },
  } });
  await sdk.update();
  const hits = (await sdk.searchLex("Azulejo", { collection: "lcm", limit: 10 }))
    .map(hit => ({ file: hit.filepath, score: hit.score }));
  const result = resolveProjectedHits({ cwd: "project", hits, limit: 10 });
  expect(result.matches.map(match => match.messageId).sort()).toEqual([1, 2]);
  expect(result.matches.every(match => match.snippet === text)).toBe(true);
  expect((await sdk.getStatus()).hasVectorIndex).toBe(false);
  db.exec("DELETE FROM messages WHERE message_id=1; UPDATE messages SET content='Changed evidence' WHERE message_id=2");
  expect(resolveProjectedHits({ cwd: "project", hits, limit: 10 })).toEqual({ matches: [], staleCount: 2 });
  expect(syncProjection("project")).toMatchObject({ written: 1, removed: 1 });
  await sdk.update();
  expect(await sdk.searchLex("Azulejo")).toEqual([]);
  db.exec("UPDATE messages SET content='   '");
  expect(syncProjection("project")).toMatchObject({ written: 0, removed: 1 });
  await sdk.update();
  expect(await sdk.searchLex("Changed")).toEqual([]);
});
