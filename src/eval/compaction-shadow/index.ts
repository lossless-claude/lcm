import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LcmPaths } from "../../lcm-paths.js";
import { loadDaemonConfig } from "../../daemon/config.js";
import { projectDir, projectId } from "../../daemon/project.js";
import { ScrubEngine } from "../../scrub.js";
import { verifyNativeTail } from "../../daemon/shadow/tail.js";
import { corpusConfigPath, readCorpusConfig, isExcluded } from "../corpus-policy.js";
import { digest, object, objectHash, validUsage, validStoredHeader, HEADER_SECTIONS, type ShadowUsage, type ArmRecord } from "../../daemon/shadow/types.js";
import { mapCompactionHeaderText } from "../../../hooks/compaction-header-schema.js";
import { prepareHeaderJob, renderCompactionDocument } from "../../daemon/shadow/header-job.js";
import { allowedProjects, shadowCandidates, discoverTranscripts, historicalCuts, type CutCandidate, type EvaluationCut, type TranscriptInput, type ReadCounts } from "./reader.js";
import { checkFaithfulness, renderHeader } from "./faithfulness.js";
import { transcriptOwnership } from "./transcript-owner.js";
import { continuationStub } from "./continuation.js";
import { validateCutIdentifiers } from "./identifiers.js";

const TOKENS_PER_MILLION = 1_000_000;
const CHARS_PER_TOKEN = 4;
const MINIMUM_CUTS = 30;
const MINIMUM_PROJECTS = 3;
export type RateTable = { version: string; models: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheCreationPerMillion: number }> };
export type Phase1Options = { paths: LcmPaths; output: string; seed?: string; limit?: number; transcriptManifest?: string; rates?: RateTable };
function price(usage: ShadowUsage | null, model: string, rates?: RateTable): number | null {
  const rate = rates && Object.hasOwn(rates.models, model) ? rates.models[model] : undefined;
  if (!validUsage(usage) || !rate) return null;
  return (usage.input_tokens * rate.inputPerMillion + usage.output_tokens * rate.outputPerMillion +
    usage.cache_read_input_tokens * rate.cacheReadPerMillion + usage.cache_creation_input_tokens * rate.cacheCreationPerMillion) / TOKENS_PER_MILLION;
}
function sumKnown(values: (number | null)[]): number | null {
  return values.length && values.every(value => value !== null) ? (values as number[]).reduce((sum, value) => sum + value, 0) : null;
}
function roundRobin<T>(queues: T[][], limit = Infinity): T[] {
  const result: T[] = [];
  while (result.length < limit && queues.some(queue => queue.length)) {
    const round = queues.flatMap(queue => queue.length ? [queue.shift()!] : []);
    result.push(...round.slice(0, limit - result.length));
  }
  return result;
}
function projectQueue(sessions: Map<string, CutCandidate[]>, seed: string): CutCandidate[] {
  const rank = (id: string) => digest(`${seed}:${id}`);
  const queues = [...sessions.entries()].sort(([a], [b]) => rank(a).localeCompare(rank(b)))
    .map(([, cuts]) => cuts.sort((a, b) => rank(a.cutId).localeCompare(rank(b.cutId))));
  return roundRobin(queues);
}
function sample(candidates: CutCandidate[], seed: string, limit: number): CutCandidate[] {
  const projects = new Map<string, Map<string, CutCandidate[]>>();
  for (const candidate of candidates) {
    const sessions = projects.get(candidate.projectId) ?? new Map<string, CutCandidate[]>();
    sessions.set(candidate.sessionId, [...(sessions.get(candidate.sessionId) ?? []), candidate]); projects.set(candidate.projectId, sessions);
  }
  const rank = (id: string) => digest(`${seed}:${id}`);
  const queues = [...projects.entries()].sort(([a], [b]) => rank(a).localeCompare(rank(b))).map(([, sessions]) => projectQueue(sessions, seed));
  return roundRobin(queues, limit);
}
function transcriptInputs(options: Phase1Options, cwds: string[]): TranscriptInput[] {
  if (!options.transcriptManifest) return discoverTranscripts(cwds);
  const parsed: unknown = JSON.parse(readFileSync(options.transcriptManifest, "utf8"));
  if (!Array.isArray(parsed) || parsed.some(row => !validTranscriptInput(row))) throw new Error("Invalid transcript manifest");
  return parsed as TranscriptInput[];
}
function validTranscriptInput(row: unknown): boolean {
  if (!object(row)) return false;
  return [row.cwd, row.sessionId, row.path].every(value => typeof value === "string");
}
function scrubCut(cut: EvaluationCut, scrubber: ScrubEngine): EvaluationCut {
  const text = (value: string) => scrubber.scrub(value);
  const header = (value: ArmRecord["header"]) => value === null ? null : value.version === 2 ? mapCompactionHeaderText(value, text) : { ...value, ...Object.fromEntries(
    HEADER_SECTIONS.map(key => [key, value[key].map(item => ({
      ...item, text: text(item.text), sources: item.sources.map(source => typeof source === "string" ? (/^\[(?:raw:[A-Za-z0-9_-]+:\d+|sum:sum_[A-Za-z0-9_-]+)\]$/.test(source) ? source : text(source)) : { quote: text(source.quote) }),
      ...(item.status ? { status: text(item.status) } : {}), ...(item.fix ? { fix: text(item.fix) } : {}),
    }))])) };
  return { ...cut, originals: cut.originals.map(row => ({ ...row, text: text(row.text) })), window: cut.window === null ? null : text(cut.window),
    engineMessages: cut.engineMessages.map(row => ({ ...row, text: text(row.text) })),
    windowItems: cut.windowItems?.map(row => ({ ...row, content: text(row.content) })) ?? null,
    native: cut.native === null ? null : { ...cut.native, text: text(cut.native.text), tail: cut.native.tail.map(row => ({ ...row, text: text(row.text) })) },
    arms: cut.arms.map(arm => ({ ...arm, text: text(arm.text), header: header(arm.header) })) };

}
const retention = (document: string, probes: readonly { text: string }[]): number | null => probes.length ? probes.filter(probe => document.includes(probe.text)).length / probes.length : null;
function armCost(records: ArmRecord[], rates?: RateTable): number | null {
  return sumKnown(records.flatMap(record => [record.costUsd ?? (record.outcome === "nothing-to-fork" ? 0 : price(record.usage, record.requestedModel, rates)),
    ...record.usageAttempts.map(attempt => price(attempt.usage, attempt.model, rates))]));
}
function measures(cut: EvaluationCut, rates?: RateTable) {
  const probes = cut.originals.filter(row => row.origin === "user" && row.text.trim()).map(row => ({ projectId: cut.projectId, sessionId: cut.sessionId, cutId: cut.cutId, rawMessageId: row.id, uuid: row.uuid, category: "verbatim-user" as const, text: row.text }));
  const tail = cut.native?.tail.map(row => row.text).join("\n\n") ?? "";
  const nativeText = [cut.native?.text ?? "", tail].filter(Boolean).join("\n\n");
  const native = cut.native ? { outcome: cut.native.outcome, summaryBytes: Buffer.byteLength(cut.native.text),
    documentBytes: cut.source === "shadow" ? Buffer.byteLength(nativeText) : null,
    estimatedTokens: Math.ceil(nativeText.length / CHARS_PER_TOKEN), probeRetention: retention(nativeText, probes), usage: cut.native.usage,
    durationMs: cut.native.durationMs, costUsd: cut.native.costUsd } : null;
  const arms = Object.fromEntries((["A", "B", "C"] as const).map(label => {
    const records = cut.arms.filter(record => record.arm === label), primary = records.find(record => record.outcome === "answered") ?? records[0];
    if (!primary) return [label, null];
    const valid = validStoredHeader(primary.header);
    const rendered = valid ? renderHeader(primary.header!) : primary.text;
    const prepared = primary.header?.version === 2 && cut.windowItems ? prepareHeaderJob({ cutId: cut.cutId, instructions: "", originals: cut.originals,
      window: cut.windowItems, tail: cut.native?.tail ?? [], engineMessages: cut.engineMessages }) : null;
    const sized = prepared && primary.header?.version === 2 ? renderCompactionDocument(prepared, primary.header) : null;
    const document = sized?.text ?? [rendered, cut.window, tail].filter(Boolean).join("\n\n");
    const summaryIds = new Map(cut.summaryCoverage.map(row => [row.summaryId, row.messageIds]));
    return [label, { outcome: primary.outcome, model: primary.requestedModel, attempts: records.length, headerValid: valid,
      faithfulness: valid ? checkFaithfulness(primary.header!, { originals: cut.originals, cutId: cut.cutId, summaries: summaryIds, ...(prepared ? { excerpts: prepared.excerpts } : {}) }) : null,
      documentOverflowBytes: sized?.overflowBytes ?? null, documentTargetBytes: sized?.targetBytes ?? null, omittedSummaryIds: sized?.omittedSummaryIds ?? null,
      documentBytes: Buffer.byteLength(document), estimatedTokens: Math.ceil(document.length / CHARS_PER_TOKEN), probeRetention: retention(document, probes),
      usage: primary.usage, durationMs: primary.durationMs, status: primary.status ?? null, errorKind: primary.errorKind ?? null, options: primary.options ?? null, costUsd: armCost(records, rates) }];
  }));
  return { probes, metrics: { projectId: cut.projectId, sessionId: cut.sessionId, cutId: cut.cutId, source: cut.source,
    sourceHash: cut.sourceHash, snapshotHash: cut.snapshotHash, nativeParity: cut.nativeParity,
    nativeComparisonEligible: Boolean(cut.native?.outcome === "answered" && cut.nativeParity !== "mismatched"), native, arms,
    contrasts: {
      A_B: { intendedFactor: "input", bothAnswered: ["A", "B"].every(label => cut.arms.some(arm => arm.arm === label && arm.outcome === "answered")),
        modelsMatch: cut.arms.find(arm => arm.arm === "A")?.requestedModel === cut.arms.find(arm => arm.arm === "B")?.requestedModel },
      B_C: { intendedFactor: "model", bothAnswered: ["B", "C"].every(label => cut.arms.some(arm => arm.arm === label && arm.outcome === "answered")),
        inputsMatch: typeof cut.arms.find(arm => arm.arm === "B")?.inputHash === "string" && cut.arms.find(arm => arm.arm === "B")?.inputHash === cut.arms.find(arm => arm.arm === "C")?.inputHash },
    },
    windowOnly: cut.window === null ? null : { bytes: Buffer.byteLength(cut.window), probeRetention: retention([cut.window, tail].join("\n\n"), probes) } } };
}
function validateRates(rates?: RateTable): void {
  if (!rates) return;
  if (!object(rates) || typeof rates.version !== "string" || !object(rates.models)) throw new Error("Invalid frozen rate table");
  if (!Object.values(rates.models).every(validModelRate)) throw new Error("Invalid frozen model/cache rates");
}

function validModelRate(rate: unknown): boolean {
  if (!object(rate)) return false;
  return ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheCreationPerMillion"].every(key => finiteRate(rate[key]));
}
function finiteRate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function pairNative(candidate: CutCandidate, context: { histories: EvaluationCut[]; scrubbers: Map<string, ScrubEngine>; counts: ReadCounts }): void {
    const index = context.histories.findIndex(cut => cut.projectId === candidate.projectId && cut.sessionId === candidate.sessionId &&
      (candidate.native?.summaryUuid ? cut.native?.summaryUuid === candidate.native.summaryUuid : cut.boundaryUuid === candidate.boundaryUuid && cut.native?.rawTextHash === candidate.native?.rawTextHash));
    if (index < 0) return;
    const historical = context.histories.splice(index, 1)[0], scrubber = context.scrubbers.get(candidate.projectId)!;
    const matched = candidate.boundaryUuid === historical.boundaryUuid && candidate.native?.rawTextHash === historical.native?.rawTextHash &&
      candidate.native?.rawTextBytes === historical.native?.rawTextBytes && scrubber.scrub(candidate.native?.text ?? "") === scrubber.scrub(historical.native?.text ?? "");
    const load = candidate.load;
    candidate.load = () => ({ ...load(), nativeParity: matched ? "matched" : "mismatched" }); context.counts.deduplicated++;
}
/** Read-only triage. No daemon, database, summarizer, retrieval or model operation. */
export async function evaluateCompactionShadow(options: Phase1Options) {
  const policyFile = corpusConfigPath(options.paths), policy = readCorpusConfig(policyFile, options.paths, { required: true });
  validateRates(options.rates);
  const seed = options.seed ?? "compaction-shadow-phase-1-v1", limit = options.limit ?? MINIMUM_CUTS;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Sample limit must be a positive integer");
  const { cuts, counts } = await loadCuts(options, { policy, seed, limit });
  const measured = cuts.map(cut => measures(cut, options.rates));
  const reportMetrics = collectMetrics({ cuts, measured, counts, seed, policyFile, rates: options.rates });
  writeReport(options.output, reportMetrics, measured.flatMap(result => result.probes));
  return reportMetrics;
}

function writeReport(output: string, metrics: ReturnType<typeof collectMetrics>, probes: ReturnType<typeof measures>["probes"]): void {
  const armSummary = metrics.armSummary;
  const selection = metrics.cuts.map(cut => ({ projectId: cut.projectId, sessionId: cut.sessionId, cutId: cut.cutId, source: cut.source, sourceHash: cut.sourceHash, snapshotHash: cut.snapshotHash }));

  const lines = ["# Compaction shadow — phase-1 triage", "", `Sample: ${metrics.sampleAdequacy.cuts} cuts across ${metrics.sampleAdequacy.projects} projects (${metrics.sampleAdequacy.sufficient ? "sufficient for triage" : "insufficient corpus"}).`,
    `Seed: ${metrics.seed}. Policy hash: ${metrics.policyHash}.`, "", "| Cut | Source | Native bytes | A bytes | B bytes | C bytes |", "|---|---|---:|---:|---:|---:|"];
  for (const cut of metrics.cuts) lines.push(`| ${cut.cutId} | ${cut.source} | ${cut.native?.documentBytes ?? "unknown"} | ${cut.arms.A?.documentBytes ?? "missing"} | ${cut.arms.B?.documentBytes ?? "missing"} | ${cut.arms.C?.documentBytes ?? "missing"} |`);
  lines.push("", "| Arm | Records / selected cuts | Answered | Unsupported identifiers | Unresolved pointers | Unknown cost |", "|---|---:|---:|---:|---:|---:|");
  for (const [label, row] of Object.entries(armSummary)) lines.push(`| ${label} | ${row.records}/${row.denominator} | ${row.answered} | ${row.unsupportedIdentifiers} | ${row.unresolvedPointers} | ${row.unknownCost} |`);
  lines.push("", "| Cut / arm | Outcome | Quote retention proxy | Estimated header cost USD | Duration ms |", "|---|---|---:|---:|---:|");
  const rows = metrics.cuts.flatMap(cut => (["A", "B", "C"] as const).map(label => ({ cutId: cut.cutId, label, row: cut.arms[label] })));
  for (const { cutId, label, row } of rows) if (row) lines.push(`| ${cutId} / ${label} | ${row.outcome} | ${row.probeRetention ?? "unknown"} | ${row.costUsd ?? "unknown"} | ${row.durationMs ?? "unknown"} |`);
  lines.push("", `Native text pairs: ${metrics.nativeTextPairs.matched} matched, ${metrics.nativeTextPairs.mismatched} mismatched. Invalid sources: ${metrics.counts.invalidSources}.`, "", "Continuation scoring: not-run/phase-2. Amortized cost: unknown.", "", ...metrics.limitations.map(line => `- ${line}`));
  if (existsSync(output)) throw new Error("Output directory must not already exist");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const artifacts: Record<string, string> = { "selection.json": JSON.stringify({ version: 1, seed: metrics.seed, policyHash: metrics.policyHash, cuts: selection }, null, 2),
    "probes.jsonl": probes.map(probe => JSON.stringify(probe)).join("\n") + (probes.length ? "\n" : ""), "metrics.json": JSON.stringify(metrics, null, 2), "report.md": lines.join("\n") + "\n" };
  for (const [name, text] of Object.entries(artifacts)) writeFileSync(join(output, name), text, { mode: 0o600, flag: "wx" });
  writeFileSync(join(output, "manifest.json"), JSON.stringify({ version: 1, artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, text]) => [name, digest(text)])), rubricHash: metrics.continuation.rubricHash }, null, 2), { mode: 0o600, flag: "wx" });
}

function collectMetrics({ cuts, measured, counts, seed, policyFile, rates }: {
  cuts: EvaluationCut[]; measured: ReturnType<typeof measures>[]; counts: ReadCounts; seed: string; policyFile: string; rates?: RateTable;
}) {
  const projects = new Set(cuts.map(cut => cut.projectId)).size;
  const metrics = { version: 1, phase: 1, seed, policyHash: digest(readFileSync(policyFile, "utf8")), rateVersion: rates?.version ?? null,
    rateHash: rates ? objectHash(rates) : null, counts,
    sampleAdequacy: { sufficient: cuts.length >= MINIMUM_CUTS && projects >= MINIMUM_PROJECTS, cuts: cuts.length, projects, requiredCuts: MINIMUM_CUTS, requiredProjects: MINIMUM_PROJECTS },
    nativeTextPairs: { matched: cuts.filter(cut => cut.nativeParity === "matched").length, mismatched: cuts.filter(cut => cut.nativeParity === "mismatched").length },
    cuts: measured.map(result => result.metrics), amortizedCostUsd: null, continuation: continuationStub(),
    limitations: ["Exact user-quote retention is a recall proxy, not semantic answer recall.", "Identifier presence does not prove relations or status; the versioned lexical classifier is a floor.", "Historical kept tails, usage and latency are unknown without frozen evidence.", "DAG/retrieval cost attribution is unavailable; no amortized-cost gate can be claimed.", "Native cost requires reported charge evidence, not a session-model guess.", "Sizes describe scrubbed text; opaque handles do not reproduce retained tool/media blocks.", "Absent prompt options and unverified effective models limit causal arm comparisons."] };
  const armSummary = Object.fromEntries((["A", "B", "C"] as const).map(label => {
    const rows = metrics.cuts.map(cut => cut.arms[label]).filter(row => row !== null);
    return [label, { denominator: cuts.length, records: rows.length, answered: rows.filter(row => row.outcome === "answered").length,
      unknownCost: rows.filter(row => row.costUsd === null).length,
      unsupportedIdentifiers: rows.reduce((sum, row) => sum + (row.faithfulness?.unsupportedIdentifiers.length ?? 0), 0),
      unresolvedPointers: rows.reduce((sum, row) => sum + (row.faithfulness?.unresolvedPointers.length ?? 0), 0) }];
  }));
  const reportMetrics = { ...metrics, armSummary };
  return reportMetrics;
}

async function loadCuts(options: Phase1Options, { policy, seed, limit }: { policy: ReturnType<typeof readCorpusConfig>; seed: string; limit: number }) {
  const counts: ReadCounts = { excludedProjects: 0, heldOutProjects: 0, invalidSources: 0, deduplicated: 0 };
  const cwds = allowedProjects(options.paths, policy, counts), ids = new Set(cwds.map(projectId));
  const config = loadDaemonConfig(options.paths.configPath), scrubbers = new Map<string, ScrubEngine>();
  for (const cwd of cwds) scrubbers.set(projectId(cwd), await ScrubEngine.forProject(config.security.sensitivePatterns, projectDir(cwd, options.paths)));
  const histories: EvaluationCut[] = [];
  const blockedSessions = new Set<string>();
  for (const input of transcriptInputs(options, cwds)) await appendHistorical(input, { policy, ids, histories, counts, blockedSessions });
  const candidates = shadowCandidates(cwds, options.paths, { counts, blockedSessions });
  const admittedHistories = histories.filter(cut => !blockedSessions.has(cut.sessionId));
  for (const candidate of candidates) pairNative(candidate, { histories: admittedHistories, scrubbers, counts });
  candidates.push(...admittedHistories.map(cut => ({ projectId: cut.projectId, sessionId: cut.sessionId, cutId: cut.cutId, load: () => cut })));
  const cuts: EvaluationCut[] = [];
  for (const candidate of sample(candidates, seed, limit)) {
    try {
      const cut = candidate.load(); validateCutIdentifiers(cut);
      const scrubber = scrubbers.get(candidate.projectId)!;
      if (cut.native) verifyNativeTail(cut.native.tail, cut.engineMessages, text => scrubber.scrub(text));
      cuts.push(scrubCut(cut, scrubber));
    } catch { counts.invalidSources++; }
  }
  return { cuts, counts };
}

async function appendHistorical(input: TranscriptInput, context: { policy: ReturnType<typeof readCorpusConfig>; ids: Set<string>; histories: EvaluationCut[]; counts: ReadCounts; blockedSessions: Set<string> }): Promise<void> {
  const excluded = (cwd: string) => isExcluded(cwd, context.policy.exclude) || context.policy.holdout.has(projectId(cwd));
  try {
    const ownership = await transcriptOwnership(input.path, { label: input.sessionId, excluded });
    const { cwd } = ownership;
    const blocked = ownership.excluded || excluded(input.cwd) || isExcluded(input.path, context.policy.exclude);
    if (blocked) for (const id of ownership.sessionIds) context.blockedSessions.add(id);
    if (ownership.invalidIdentity) { context.counts.invalidSources++; return; }
    if (blocked) return;
    if (!context.ids.has(projectId(cwd))) return;
    context.histories.push(...historicalCuts({ ...input, cwd }));
  } catch { context.counts.invalidSources++; }
}
