import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importSessions } from "../src/import.js";
import { claudeProjectSlug, projectId } from "../src/daemon/project.js";
import type { DaemonClient } from "../src/daemon/client.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lcm-import-promotion-"));
  roots.push(root);
  const transcripts = join(root, "transcripts");
  for (const cwd of ["/promotion/a", "/promotion/b", "/promotion/skipped"]) {
    const project = join(root, "projects", projectId(cwd));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "meta.json"), JSON.stringify({ cwd }));
    const dir = join(transcripts, claudeProjectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    for (const session of ["one", "two"]) writeFileSync(join(dir, `${session}.jsonl`), "");
  }
  const post = vi.fn(async (route: string, body: any) => {
    if (route === "/ingest") return { ingested: 1, totalTokens: 100 };
    if (route === "/compact") return body.cwd.endsWith("skipped")
      ? { replayOutcome: "no_work" }
      : { replayOutcome: "compacted", latestSummaryContent: "durable insight" };
    if (route === "/promote") return { processed: 1, promoted: 1 };
    throw new Error(`Unexpected route ${route}`);
  });
  return {
    client: { post } as unknown as DaemonClient, post,
    options: { provider: "claude" as const, all: true, replay: true, _lcmDir: root, _claudeProjectsDir: transcripts },
  };
}

it("promotes once per compacted project after import replay finishes", async () => {
  const { client, post, options } = fixture();
  await importSessions(client, options);
  const promotions = post.mock.calls.filter(([route]) => route === "/promote");
  expect(promotions.map(([, body]) => body)).toEqual([
    { cwd: "/promotion/a", dry_run: false }, { cwd: "/promotion/b", dry_run: false },
  ]);
  expect(post.mock.calls.slice(-2).map(([route]) => route)).toEqual(["/promote", "/promote"]);
});

it("skips promotion with noPromote even after successful compaction", async () => {
  const { client, post, options } = fixture();
  await importSessions(client, { ...options, noPromote: true });
  expect(post.mock.calls.some(([route]) => route === "/compact")).toBe(true);
  expect(post.mock.calls.some(([route]) => route === "/promote")).toBe(false);
});

it("passes the CLI --no-promote opt-out to import", async () => {
  const { Command } = await import("commander");
  const importer = await import("../src/import.js");
  const { registerImportCommand } = await import("../src/cli/knowledge.js");
  const run = vi.spyOn(importer, "importSessions").mockResolvedValue({
    imported: 0, skippedEmpty: 0, failed: 0, totalMessages: 0, totalTokens: 0, tokensAfter: 0,
  });
  const program = new Command();
  registerImportCommand(program, { createDaemonClientOrExit: async () => ({}) as DaemonClient });
  try {
    await program.parseAsync(["import", "--replay", "--no-promote"], { from: "user" });
    expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ replay: true, noPromote: true });
  } finally {
    run.mockRestore();
  }
});

it("explains automatic import promotion and the existing backlog command in help", async () => {
  const { printHelp } = await import("../src/cli-help.js");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    printHelp("import");
    const help = output.mock.calls.map(([text]) => text).join("");
    expect(help).toContain("--no-promote");
    expect(help).toContain("automatically");
    expect(help).toContain("lcm promote --all");
  } finally {
    output.mockRestore();
  }
});


it.each([{ dryRun: true }, { replay: false }])("does not promote without compaction: %j", async (mode) => {
  const { client, post, options } = fixture();
  await importSessions(client, { ...options, ...mode });
  expect(post.mock.calls.some(([route]) => route === "/promote")).toBe(false);
});

it("skips promotion if the daemon becomes unreachable after a successful compact", async () => {
  const { client, post, options } = fixture();
  const handler = post.getMockImplementation()!;
  let compactions = 0;
  post.mockImplementation(async (route, body) => {
    if (route === "/compact" && ++compactions === 2) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    return handler(route, body);
  });
  const result = await importSessions(client, options);
  expect(result.daemonUnreachable).toBe(true);
  expect(post.mock.calls.some(([route]) => route === "/promote")).toBe(false);
});

it("continues promotion for other projects after a promotion failure", async () => {
  const { client, post, options } = fixture();
  const handler = post.getMockImplementation()!;
  post.mockImplementation(async (route, body) => {
    if (route === "/promote" && body.cwd === "/promotion/a") throw new Error("promotion failed");
    return handler(route, body);
  });
  await expect(importSessions(client, options)).resolves.toMatchObject({ imported: 6, failed: 0 });
  expect(post.mock.calls.filter(([route]) => route === "/promote")).toHaveLength(2);
});
