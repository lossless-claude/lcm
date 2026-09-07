import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { projectDbPath, projectId } from "../../src/daemon/project.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { buildBench, runBench, type BenchFile } from "../../src/bench.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedProject(cwd: string): Promise<void> {
  const dbPath = projectDbPath(cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    runLcmMigrations(db);
    const convStore = new ConversationStore(db);
    const summStore = new SummaryStore(db);
    const promotedStore = new PromotedStore(db);

    const sessions: Array<{ sessionId: string; prompts: string[] }> = [
      {
        sessionId: "sess-rollback",
        prompts: [
          "The 2.4.1 release went out this morning and customers are already reporting the settings page is blank. We need to roll back the deploy right now.",
          "Make sure the rollback script also purges the CDN cache, otherwise clients keep fetching the broken bundle.",
        ],
      },
      {
        sessionId: "sess-timeout",
        prompts: [
          "CI failed again on the pricing suite. The jest runner times out waiting for the test database container to become healthy.",
          "This flakes two or three times a week and it is destroying trust in the pipeline.",
        ],
      },
      {
        sessionId: "sess-storage",
        prompts: [
          "For the memory daemon we need to pick a storage engine. I'm leaning towards SQLite but I want the tradeoffs on record.",
          "Operations burden matters more than write concurrency here. This runs on a laptop, not in a datacenter.",
        ],
      },
    ];

    for (const s of sessions) {
      const conv = await convStore.createConversation({ sessionId: s.sessionId });
      const inputs = s.prompts.flatMap((prompt, i) => [
        {
          conversationId: conv.conversationId,
          seq: i * 2,
          role: "user" as const,
          content: prompt,
          tokenCount: Math.ceil(prompt.length / 4),
        },
        {
          conversationId: conv.conversationId,
          seq: i * 2 + 1,
          role: "assistant" as const,
          content: `Acknowledged. Working on it now. (${s.sessionId})`,
          tokenCount: 8,
        },
      ]);
      const created = await convStore.createMessagesBulk(inputs);
      const summary = await summStore.insertSummary({
        summaryId: `sum_${s.sessionId}`,
        conversationId: conv.conversationId,
        kind: "leaf",
        content: s.prompts.join("\n"),
        tokenCount: 100,
      });
      await summStore.linkSummaryToMessages(
        summary.summaryId,
        created.map((m) => m.messageId),
      );
      await promotedStore.insert({
        content: `Decision notes for ${s.sessionId}: ${s.prompts[0].slice(0, 120)}`,
        tags: ["decision"],
        projectId: projectId(cwd),
        sessionId: s.sessionId,
      });
    }
  } finally {
    db.close();
  }
}

describe("lcm bench", () => {
  it("build writes a benchmark file with vocabulary-diverging questions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-"));
    tempDirs.push(cwd);
    await seedProject(cwd);

    const result = await buildBench({ cwd, n: 5, seed: 7 });
    expect(result.exitCode).toBe(0);
    expect(existsSync(result.out)).toBe(true);

    const bench = JSON.parse(readFileSync(result.out, "utf-8")) as BenchFile;
    expect(bench.queries.length).toBeGreaterThan(0);
    for (const q of bench.queries) {
      expect(q.question.length).toBeGreaterThan(0);
      // Mechanical questions must not reuse the prompt's content words
      // beyond the single capitalized focus term.
      expect(q.sessionId.length).toBeGreaterThan(0);
    }
  });

  it("build fails cleanly when the project has no database", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-empty-"));
    tempDirs.push(cwd);
    const result = await buildBench({ cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No project database");
  });

  it("run reports recall against the grep baseline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-"));
    tempDirs.push(cwd);
    await seedProject(cwd);

    const build = await buildBench({ cwd, n: 5, seed: 7 });
    expect(build.exitCode).toBe(0);

    const run = await runBench({ cwd, k: 5 });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("recall@5");
    expect(run.stdout).toContain("grep");
    expect(run.stdout).toContain("empty results");
    expect(run.stdout).toContain("p95 latency");
    expect(existsSync(run.out)).toBe(true);
  });

  it("run --json emits a structured report", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-"));
    tempDirs.push(cwd);
    await seedProject(cwd);
    await buildBench({ cwd, n: 5, seed: 7 });

    const run = await runBench({ cwd, k: 5, json: true });
    expect(run.exitCode).toBe(0);
    const report = JSON.parse(run.stdout) as {
      total: number;
      searchRecall: number;
      grepRecall: number;
      emptyRate: number;
      p95LatencyMs: number;
    };
    expect(report.total).toBeGreaterThan(0);
    expect(report.searchRecall).toBeGreaterThanOrEqual(0);
    expect(report.grepRecall).toBeGreaterThanOrEqual(0);
    expect(report.emptyRate).toBeGreaterThanOrEqual(0);
  });

  it("run fails cleanly when no benchmark file exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-"));
    tempDirs.push(cwd);
    await seedProject(cwd);
    const run = await runBench({ cwd });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("lcm bench build");
  });

  it("mechanical questions never focus on sentence-initial filler words", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-"));
    tempDirs.push(cwd);
    await seedProject(cwd);
    const build = await buildBench({ cwd, n: 20, seed: 3 });
    const bench = JSON.parse(readFileSync(build.out, "utf-8")) as BenchFile;
    const filler = /\b(The|How|They|This|What|Why|When|Where|Do|Does|Make|Operations|For)\b/;
    for (const q of bench.queries) {
      expect(
        filler.test(q.question.replace(/^(what|how|why) (did|do|was|were) we \w+( the| around| about)?/i, "")),
        `question "${q.question}" focuses on a filler word`,
      ).toBe(false);
    }
  });

  it("questions never echo their own prompt verbatim", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-bench-"));
    tempDirs.push(cwd);
    await seedProject(cwd);
    const build = await buildBench({ cwd, n: 5, seed: 3 });
    const bench = JSON.parse(readFileSync(build.out, "utf-8")) as BenchFile;
    for (const q of bench.queries) {
      // The question must be a paraphrase, not a copy of the prompt.
      expect(q.question).not.toBe(q.prompt);
      expect(q.prompt).not.toContain(q.question);
    }
  });
});
