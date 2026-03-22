/**
 * E2E Test Harness
 *
 * Manages an isolated test daemon + database for E2E flow tests.
 *
 * NOTE: Flow tests may need `testTimeout: 60_000` in vitest.config.ts
 * because daemon startup + ingest pipelines can take several seconds.
 */

import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createDaemon } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { projectId, projectDir, projectDbPath } from "../../src/daemon/project.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures", "e2e");
const PROJECTS_DIR = join(homedir(), ".lossless-claude", "projects");

// ─── Public types ────────────────────────────────────────────────────────────

export interface HarnessHandle {
  /** Isolated temp directory for this test run */
  tmpDir: string;
  /** SQLite path inside the test project dir */
  dbPath: string;
  /** Port the test daemon is listening on */
  daemonPort: number;
  /** Production DaemonClient pointed at the test daemon (dogfooding) */
  client: DaemonClient;
  /** Path to session-main.jsonl fixture */
  fixturePath: string;
  /** Path to subagent fixture */
  fixtureSubagentPath: string;
  mode: "mock" | "live";
  cleanup(): Promise<void>;
}

export interface FlowResult {
  name: string;
  status: "pass" | "fail" | "skip";
  notes: string;
  durationMs: number;
}

// ─── Orphan cleanup ──────────────────────────────────────────────────────────

/**
 * Removes any orphaned project directories from previously crashed E2E runs.
 * Looks for projects whose meta.json cwd contains "e2e-test-".
 */
function cleanupOrphanedProjects(): void {
  if (!existsSync(PROJECTS_DIR)) return;
  try {
    for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(PROJECTS_DIR, entry.name, "meta.json");
      if (!existsSync(metaPath)) continue;
      let meta: { cwd?: string } = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      } catch {
        continue;
      }
      if (meta.cwd && meta.cwd.includes("e2e-test-")) {
        try {
          rmSync(join(PROJECTS_DIR, entry.name), { recursive: true, force: true });
        } catch {
          // Non-fatal: best-effort cleanup
        }
      }
    }
  } catch {
    // Non-fatal: if scan fails, continue
  }
}

// ─── Fixture copy ────────────────────────────────────────────────────────────

function copyFixtures(destDir: string): void {
  // Copy session-main.jsonl
  copyFileSync(
    join(FIXTURES_DIR, "session-main.jsonl"),
    join(destDir, "session-main.jsonl"),
  );
  // Copy subagents/subagent-task-1.jsonl
  const subagentsDir = join(destDir, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  copyFileSync(
    join(FIXTURES_DIR, "subagents", "subagent-task-1.jsonl"),
    join(subagentsDir, "subagent-task-1.jsonl"),
  );
}

// ─── createHarness ───────────────────────────────────────────────────────────

export async function createHarness(mode: "mock" | "live"): Promise<HarnessHandle> {
  // 1. Defensive cleanup of any orphaned test projects from prior crashed runs
  cleanupOrphanedProjects();

  // 2. Create isolated temp directory
  const tmpDir = mkdtempSync(join(tmpdir(), "e2e-test-"));

  // 3. Copy fixtures into temp dir (maintaining directory structure)
  copyFixtures(tmpDir);

  // 4. Build test config using loadDaemonConfig with overrides
  //    - port: 0 → OS picks a free port
  //    - idleTimeoutMs: 0 → no idle timeout in tests
  //    - llm.provider: "disabled" → no actual summarization in mock mode
  const configOverrides = {
    daemon: {
      port: 0,
      idleTimeoutMs: 0,
    },
    llm: {
      provider: mode === "mock" ? "disabled" : "auto",
    },
  };

  // Write the test config to a temp file so loadDaemonConfig can read it
  const configPath = join(tmpDir, "config.json");
  writeFileSync(configPath, JSON.stringify(configOverrides, null, 2));

  const config = loadDaemonConfig(configPath, configOverrides, {
    // Pass empty env to avoid env-var overrides interfering with tests
    ...process.env,
    LCM_SUMMARY_PROVIDER: undefined,
  });

  // 5. Start a real daemon
  const daemon = await createDaemon(config);
  const daemonPort = daemon.address().port;

  // 6. Create production DaemonClient pointed at the test daemon
  const client = new DaemonClient(`http://127.0.0.1:${daemonPort}`);

  const dbPath = projectDbPath(tmpDir);
  const fixturePath = join(tmpDir, "session-main.jsonl");
  const fixtureSubagentPath = join(tmpDir, "subagents", "subagent-task-1.jsonl");

  // 7. Build and return the handle
  const handle: HarnessHandle = {
    tmpDir,
    dbPath,
    daemonPort,
    client,
    fixturePath,
    fixtureSubagentPath,
    mode,
    async cleanup() {
      // Stop the daemon
      await daemon.stop();

      // Remove the temp dir
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }

      // Remove the test project from ~/.lossless-claude/projects/<hash>/
      const pDir = projectDir(tmpDir);
      if (existsSync(pDir)) {
        try {
          rmSync(pDir, { recursive: true, force: true });
        } catch {
          // Non-fatal
        }
      }
    },
  };

  return handle;
}

// ─── Helper utilities ────────────────────────────────────────────────────────

/**
 * Polls the daemon's health endpoint until it responds or times out.
 */
export async function waitForDaemon(
  client: DaemonClient,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await client.health();
    if (health?.status === "ok") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon did not respond within ${timeoutMs}ms`);
}

/**
 * Opens the project SQLite database for assertions.
 * Returns { db, close } — call close() when done.
 */
export function openProjectDb(cwd: string): {
  db: DatabaseSync;
  close: () => void;
} {
  const dbPath = projectDbPath(cwd);
  const db = new DatabaseSync(dbPath);
  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Asserts that a table has exactly `expected` rows.
 * Throws an AssertionError if the count doesn't match.
 */
export function assertRowCount(
  db: DatabaseSync,
  table: string,
  expected: number,
): void {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
    count: number;
  };
  if (row.count !== expected) {
    throw new Error(
      `Expected ${expected} rows in "${table}" but got ${row.count}`,
    );
  }
}
