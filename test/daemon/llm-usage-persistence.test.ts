import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { recordCompactLlmUsage, type CompactLlmUsage } from "../../src/daemon/routes/compact.js";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  return db;
}

function usage(overrides: Partial<CompactLlmUsage> = {}): CompactLlmUsage {
  return {
    provider: "codex-process",
    model: "gpt-5.6",
    calls: 1,
    okCalls: 1,
    failedCalls: 0,
    tokensSpent: 30597,
    tokensInput: 30592,
    tokensCached: 7040,
    tokensOutput: 5,
    ...overrides,
  };
}

function readRow(db: DatabaseSync) {
  return db.prepare(`SELECT * FROM llm_usage_stats`).all() as Record<string, number | string>[];
}

describe("llm_usage_stats persistence", () => {
  it("writes the full token breakdown for a call", () => {
    const db = migratedDb();
    try {
      recordCompactLlmUsage(db, usage());
      expect(readRow(db)).toHaveLength(1);
      expect(readRow(db)[0]).toMatchObject({
        provider: "codex-process",
        model: "gpt-5.6",
        calls_total: 1,
        tokens_spent_total: 30597,
        tokens_input_total: 30592,
        tokens_cached_total: 7040,
        tokens_output_total: 5,
      });
    } finally {
      db.close();
    }
  });

  it("accumulates every counter on conflict instead of replacing the row", () => {
    const db = migratedDb();
    try {
      recordCompactLlmUsage(db, usage());
      recordCompactLlmUsage(db, usage({ failedCalls: 1, okCalls: 0 }));
      const [row] = readRow(db);
      expect(row).toMatchObject({
        calls_total: 2,
        calls_ok: 1,
        calls_failed: 1,
        tokens_spent_total: 61194,
        tokens_input_total: 61184,
        tokens_cached_total: 14080,
        tokens_output_total: 10,
      });
    } finally {
      db.close();
    }
  });

  it("keeps a provider that reports output tokens only on its own row", () => {
    const db = migratedDb();
    try {
      recordCompactLlmUsage(db, usage());
      recordCompactLlmUsage(db, usage({
        provider: "copilot-process",
        model: "",
        tokensSpent: 221,
        tokensInput: 0,
        tokensCached: 0,
        tokensOutput: 221,
      }));
      expect(readRow(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("skips the write when no call reported usage", () => {
    const db = migratedDb();
    try {
      recordCompactLlmUsage(db, usage({ calls: 0 }));
      expect(readRow(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("adds the breakdown columns to a pre-existing table without losing totals", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // The schema as it shipped before the breakdown existed.
      db.exec(`
        CREATE TABLE llm_usage_stats (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          calls_total INTEGER NOT NULL DEFAULT 0,
          calls_ok INTEGER NOT NULL DEFAULT 0,
          calls_failed INTEGER NOT NULL DEFAULT 0,
          tokens_spent_total INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (provider, model)
        );
        INSERT INTO llm_usage_stats (provider, model, calls_total, calls_ok, tokens_spent_total)
        VALUES ('codex-process', 'gpt-5.6', 4, 4, 1000);
      `);

      runLcmMigrations(db);

      const columns = (db.prepare(`PRAGMA table_info(llm_usage_stats)`).all() as { name: string }[])
        .map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining([
        "tokens_input_total", "tokens_cached_total", "tokens_output_total",
      ]));

      const [row] = readRow(db);
      expect(row).toMatchObject({
        calls_total: 4,
        tokens_spent_total: 1000,
        // Historical rows have no breakdown; they backfill to zero, not to the total.
        tokens_input_total: 0,
        tokens_output_total: 0,
      });

      // The upgraded table still accepts the new write path.
      recordCompactLlmUsage(db, usage({ tokensSpent: 1 }));
      expect(readRow(db)).toHaveLength(1);
      expect(readRow(db)[0].tokens_input_total).toBe(30592);
    } finally {
      db.close();
    }
  });
});
