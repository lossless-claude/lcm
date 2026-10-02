import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { projectDir, projectId } from "../../src/daemon/project.js";
import { objectHash, digest, type ShadowHeader } from "../../src/daemon/shadow/types.js";
import { ScrubEngine } from "../../src/scrub.js";

let root: string, cwd: string, paths: LcmPaths, output: string, transcripts: { cwd: string; sessionId: string; path: string }[];
const directive = "Keep parser.ts and #42. Run npm test.";
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
function header(text = directive, source = "[raw:cut-a:1]"): ShadowHeader {
  return { version: 1, directives: [{ text, sources: [source] }], intent: [], decisions: [], taskAndNextStep: [], openThreads: [], files: [], errors: [] };
}
function project(name: string) {
  const cwd = join(root, "work", name); mkdirSync(cwd, { recursive: true });
  mkdirSync(projectDir(cwd, paths), { recursive: true });
  writeFileSync(join(projectDir(cwd, paths), "meta.json"), JSON.stringify({ cwd })); return cwd;
}
function file(name: string) { return join(projectDir(cwd, paths), "compaction-shadow", "cut-a", name); }
function writeShadow() {
  const snapshot = { version: 1, originals: [{ id: 1, seq: 0, role: "user", text: directive, origin: "user", uuid: "one" },
    { id: 2, seq: 1, role: "assistant", text: "raw assistant", origin: "other", uuid: "two" }], engineMessages: [], sourceHash: "a".repeat(64),
    window: { text: directive + "\nraw assistant", coverage: { capturedMessageIds: [1, 2], renderedMessageIds: [1, 2], summaryCoverage: [], uncoveredMessageIds: [], valid: true } } };
  mkdirSync(join(projectDir(cwd, paths), "compaction-shadow", "cut-a"), { recursive: true });
  writeFileSync(file("snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(file("manifest.json"), JSON.stringify({ version: 1, cwd, projectId: projectId(cwd), cutId: "cut-a", sessionId: "s1", conversationId: 1,
    boundaryUuid: "two", trigger: "manual", model: "fixture-model", instructions: "", snapshotHash: objectHash(snapshot), rulesKey: new ScrubEngine([], []).rulesKey,
    createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z", owner: "fixture", state: "complete", expectedArms: ["A", "B", "C"] }));
  writeFileSync(file("native.json"), JSON.stringify({ text: "Keep parser.ts.", outcome: "answered", usage, durationMs: 10, costUsd: null,
    tail: [{ role: "assistant", text: "raw assistant", handle: "h2" }], rawTextHash: digest("Keep parser.ts."), rawTextBytes: 15, summaryUuid: "native-1" }));
  for (const arm of ["A", "B", "C"]) writeFileSync(file(`arm-${arm}-first.json`), JSON.stringify({ arm, attemptId: "first", requestedModel: arm === "C" ? "sonnet" : "fixture-model",
    text: arm === "C" ? "Touch ghost.ts." : directive, header: arm === "C" ? header("Touch ghost.ts.") : header(directive, arm === "B" ? "[sum:sum_fake]" : undefined),
    inputHash: objectHash(snapshot), promptHash: "b".repeat(64), outcome: "answered", usage, usageAttempts: [], durationMs: 12, costUsd: null }));
}
function history(owner = cwd, sessionId = "s1", suffix = "", nativeText = "Keep parser.ts.") {
  const path = join(root, `${sessionId}${suffix}.jsonl`);
  writeFileSync(path, [
    { uuid: "one", parentUuid: null, type: "user", message: { role: "user", content: directive } },
    { uuid: "abandoned", parentUuid: "one", type: "user", message: { role: "user", content: "Never use abandoned.ts" } },
    { uuid: "two", parentUuid: "one", type: "assistant", message: { role: "assistant", content: "raw assistant" } },
    { uuid: "boundary", parentUuid: "two", type: "system", subtype: "compact_boundary" },
    { uuid: "native-1", parentUuid: "boundary", type: "user", isCompactSummary: true, message: { role: "user", content: [{ type: "text", text: nativeText }] } },
    { uuid: "future", parentUuid: "native-1", type: "user", message: { role: "user", content: "Use future.ts PRIVATE_WORD" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  transcripts.push({ cwd: owner, sessionId, path }); return path;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-shadow-eval-")); paths = createLcmPaths(join(root, "lcm")); mkdirSync(paths.home);
  cwd = project("alpha"); output = join(root, "report"); transcripts = [];
  writeFileSync(join(paths.home, "bench-corpora.json"), "{}");
  writeFileSync(paths.configPath, JSON.stringify({ security: { sensitivePatterns: ["PRIVATE_WORD"] } }));
  writeShadow();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(extra: string[] = []) {
  const manifest = join(root, "transcripts.json"); writeFileSync(manifest, JSON.stringify(transcripts));
  return spawnSync(process.execPath, ["--experimental-strip-types", "scripts/eval-compaction-shadow.mts", "--home", paths.home, "--output", output,
    "--transcripts", manifest, "--seed", "frozen-seed", ...extra], { encoding: "utf8" });
}
function report() {
  const result = run(); expect(result.status, result.stderr).toBe(0); return JSON.parse(readFileSync(join(output, "metrics.json"), "utf8"));
}
describe("offline compaction shadow triage", () => {
  it("requires a policy before loading any corpus", () => {
    rmSync(join(paths.home, "bench-corpora.json")); const result = run();
    expect(result.status).toBe(1); expect(result.stderr).toContain("policy is required"); expect(existsSync(output)).toBe(false);
  });
  it.each(["broken JSON", JSON.stringify({ excludeCwdContaining: ["unmatched"] })])("fails closed on malformed or unresolvable policy (%s)", policy => {
    writeFileSync(join(paths.home, "bench-corpora.json"), policy); const result = run();
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/JSON|matches no ingested project/); expect(existsSync(output)).toBe(false);
  });
  it("excludes shadow payloads and explicit transcript paths before loading", () => {
    const privateCwd = project("private");
    const privateCut = join(projectDir(privateCwd, paths), "compaction-shadow", "bad"); mkdirSync(privateCut, { recursive: true });
    writeFileSync(join(privateCut, "manifest.json"), "unreadable excluded corpus");
    const badPath = join(root, "bad.jsonl"); writeFileSync(badPath, "unreadable excluded corpus");
    transcripts.push({ cwd: privateCwd, sessionId: "private", path: badPath });
    writeFileSync(join(paths.home, "bench-corpora.json"), JSON.stringify({ exclude: [privateCwd] }));
    const metrics = report(); expect(metrics.counts.excludedProjects).toBe(1); expect(metrics.counts.invalidSources).toBe(0);
    expect(metrics.cuts).toHaveLength(1);
  });
  it("reports missing identifiers, pointers and verbatim directives independently", () => {
    const metrics = report(); const cut = metrics.cuts[0];
    expect(cut.arms.A.faithfulness.unsupportedIdentifiers).toEqual([]);
    expect(cut.arms.A.faithfulness.unresolvedPointers).toEqual([]);
    expect(cut.arms.B.faithfulness.unresolvedPointers).toContain("[sum:sum_fake]");
    expect(cut.arms.C.faithfulness.unsupportedIdentifiers).toContain("ghost.ts");
    expect(cut.arms.C.faithfulness.verbatimFailures).toBe(1);
    expect(cut.arms.A.probeRetention).toBe(1); expect(cut.native.probeRetention).toBe(0);
  });
  it("uses only active pre-cut user originals in historical probes", () => {
    rmSync(join(projectDir(cwd, paths), "compaction-shadow"), { recursive: true }); history();
    const metrics = report();
    const probes = readFileSync(join(output, "probes.jsonl"), "utf8");
    expect(metrics.cuts).toHaveLength(1); expect(probes).toContain(directive);
    expect(probes).not.toContain("abandoned.ts"); expect(probes).not.toContain("future.ts");
    expect(metrics.cuts[0].arms.A).toBeNull(); expect(metrics.cuts[0].windowOnly).toBeNull();
  });
  it("pairs native hook text with identical decoded JSONL and deduplicates the cut", () => {
    history(); const metrics = report();
    expect(metrics.cuts).toHaveLength(1); expect(metrics.nativeTextPairs).toMatchObject({ matched: 1, mismatched: 0 });
    expect(metrics.cuts[0].nativeComparisonEligible).toBe(true);
  });
  it("does not normalize away a hook/JSONL native text mismatch", () => {
    history(cwd, "s1", "", "Keep parser.ts.\n"); const metrics = report();
    expect(metrics.nativeTextPairs.mismatched).toBe(1); expect(metrics.cuts[0].nativeComparisonEligible).toBe(false);
  });
  it("samples reproducibly across at least 30 sessions and 3 allowed projects", () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const owner = name === "alpha" ? cwd : project(name);
      for (let i = 0; i < 11; i++) history(owner, `${name}-${i}`, `-${name}`);
    }
    const first = report(); const selection = readFileSync(join(output, "selection.json"), "utf8");
    rmSync(output, { recursive: true }); const second = report();
    expect(first.sampleAdequacy).toMatchObject({ sufficient: true, cuts: 30, projects: 3 });
    expect(readFileSync(join(output, "selection.json"), "utf8")).toBe(selection);
    expect(second.cuts.map((cut: any) => cut.cutId)).toEqual(first.cuts.map((cut: any) => cut.cutId));
  });
  it("reserves held-out projects without letting them into triage", () => {
    writeFileSync(join(paths.home, "bench-corpora.json"), JSON.stringify({ holdout: [cwd] }));
    const metrics = report(); expect(metrics.cuts).toEqual([]); expect(metrics.counts.heldOutProjects).toBe(1);
  });
  it("retains exact cache costs, reports unknown cost and never runs the phase-2 judge", () => {
    const rates = join(root, "rates.json"); writeFileSync(rates, JSON.stringify({ version: "fixture-v1", models: { "fixture-model": {
      inputPerMillion: 10, outputPerMillion: 100, cacheReadPerMillion: 1, cacheCreationPerMillion: 20,
    } } }));
    const result = run(["--rates", rates]); expect(result.status, result.stderr).toBe(0);
    const metrics = JSON.parse(readFileSync(join(output, "metrics.json"), "utf8"));
    expect(metrics.cuts[0].arms.A.costUsd).toBeCloseTo(0.0008, 8);
    expect(metrics.cuts[0].arms.C.costUsd).toBeNull(); expect(metrics.cuts[0].arms.A.usage.cache_read_input_tokens).toBe(100);
    expect(metrics.cuts[0].native.documentBytes).toBeGreaterThan(metrics.cuts[0].native.summaryBytes);
    expect(metrics.continuation.status).toBe("not-run/phase-2"); expect(metrics.amortizedCostUsd).toBeNull();
  });
  it("rejects changed snapshots and keeps after-cut data out of the report", () => {
    const snapshot = JSON.parse(readFileSync(file("snapshot.json"), "utf8")); snapshot.window.text += " future.ts";
    writeFileSync(file("snapshot.json"), JSON.stringify(snapshot)); const metrics = report();
    expect(metrics.counts.invalidSources).toBe(1); expect(metrics.cuts).toEqual([]);
    expect(readFileSync(join(output, "report.md"), "utf8")).not.toContain("future.ts");
  });
  it("scrubs all probe and report text with current capture rules", () => {
    const snapshot = JSON.parse(readFileSync(file("snapshot.json"), "utf8")); snapshot.originals[0].text += " PRIVATE_WORD";
    writeFileSync(file("snapshot.json"), JSON.stringify(snapshot));
    const manifest = JSON.parse(readFileSync(file("manifest.json"), "utf8")); manifest.snapshotHash = objectHash(snapshot);
    writeFileSync(file("manifest.json"), JSON.stringify(manifest)); report();
    for (const name of ["selection.json", "probes.jsonl", "metrics.json", "report.md", "manifest.json"])
      expect(readFileSync(join(output, name), "utf8")).not.toContain("PRIVATE_WORD");
  });
  it("reports incomplete JSONL as invalid rather than taking an unverified prefix", () => {
    const path = history(); writeFileSync(path, readFileSync(path, "utf8") + '{"uuid":"unfinished"');
    const metrics = report(); expect(metrics.counts.invalidSources).toBe(1); expect(metrics.cuts).toHaveLength(1);
  });
  it("resolves frozen summary lineage while still applying the literal identifier floor", () => {
    const snapshot = JSON.parse(readFileSync(file("snapshot.json"), "utf8"));
    snapshot.window.coverage.renderedMessageIds = [2];
    snapshot.window.coverage.summaryCoverage = [{ summaryId: "sum_real", messageIds: [1] }];
    snapshot.window.text = "Summary [sum_real]: Keep parser.ts.";
    writeFileSync(file("snapshot.json"), JSON.stringify(snapshot));
    const manifest = JSON.parse(readFileSync(file("manifest.json"), "utf8")); manifest.snapshotHash = objectHash(snapshot);
    writeFileSync(file("manifest.json"), JSON.stringify(manifest));
    const arm = JSON.parse(readFileSync(file("arm-B-first.json"), "utf8")); arm.header = header(directive, "[sum:sum_real]");
    writeFileSync(file("arm-B-first.json"), JSON.stringify(arm)); const metrics = report();
    expect(metrics.cuts[0].arms.B.faithfulness.unresolvedPointers).toEqual([]);
    expect(metrics.cuts[0].arms.B.faithfulness.unsupportedIdentifiers).toContain("sum_real");
  });
  it("checks script commands and identifier boundaries without accepting a prefix", () => {
    const arm = JSON.parse(readFileSync(file("arm-C-first.json"), "utf8")); arm.header = header("Run npm run imaginary. Touch parser.tsx and #420.");
    writeFileSync(file("arm-C-first.json"), JSON.stringify(arm)); const metrics = report();
    expect(metrics.cuts[0].arms.C.faithfulness.unsupportedIdentifiers).toEqual(expect.arrayContaining(["npm run imaginary", "parser.tsx", "#420"]));
  });
  it("scrubs corpus text without changing role and outcome metadata", () => {
    writeFileSync(paths.configPath, JSON.stringify({ security: { sensitivePatterns: ["user", "answered"] } }));
    const metrics = report();
    expect(metrics.cuts[0].arms.A.outcome).toBe("answered");
    expect(metrics.cuts[0].arms.A.probeRetention).toBe(1);
  });
});
