import type { EvalRunResult, SummarizerCall } from "./engine.js";
import type { UnsupportedDetail } from "./unsupported-details.js";

export type ComparisonChunk = {
  label: string;
  run: number;
  source: string;
  entries: Array<{ endpoint: string; calls: SummarizerCall[] }>;
};

export type ComparisonReport = {
  version: 1;
  createdAt: string;
  sessionId: string;
  language?: string;
  settings: Record<string, unknown>;
  candidates: Array<{ name: string; type: string; model: string }>;
  results: Array<EvalRunResult & { endpoint: string }>;
  chunks: ComparisonChunk[];
  notice: string;
};

/** Align by source text, not call index: retries and failed runs need not have equal lengths. */
export function comparisonChunks(results: ComparisonReport["results"], endpoints: string[]): ComparisonChunk[] {
  const chunks = new Map<string, ComparisonChunk>();
  for (const result of results) {
    for (const call of result.calls.filter((entry) => entry.pass === "leaf")) {
      const key = JSON.stringify([result.label, result.run, call.source]);
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = { label: result.label, run: result.run, source: call.source, entries: endpoints.map((endpoint) => ({ endpoint, calls: [] })) };
        chunks.set(key, chunk);
      }
      chunk.entries.find((entry) => entry.endpoint === result.endpoint)!.calls.push(call);
    }
  }
  return [...chunks.values()];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function highlight(text: string, details: UnsupportedDetail[]): string {
  let rendered = "";
  let cursor = 0;
  for (const detail of details) {
    rendered += escapeHtml(text.slice(cursor, detail.start));
    rendered += `<mark title="Unsupported ${detail.kind}">${escapeHtml(text.slice(detail.start, detail.end))}</mark>`;
    cursor = detail.end;
  }
  return rendered + escapeHtml(text.slice(cursor));
}

const number = (value: number | null): string => value === null ? "unknown" : value.toLocaleString("en-US", { maximumFractionDigits: 3 });

export function renderComparison(report: ComparisonReport): string {
  const rows = report.results.map((result) => {
    const total = result.totals;
    const facts = result.plantedFacts ? `${result.plantedFacts.filter((fact) => fact.survived).length}/${result.plantedFacts.length}` : "—";
    return `<tr><th scope="row">${escapeHtml(result.endpoint)}<small>${escapeHtml(result.model)}</small></th>
      <td>${escapeHtml(result.label)}<small>Run ${result.run}${result.incomplete ? " · incomplete" : ""}</small></td>
      <td>${total.calls}</td><td>${number(total.latencyMs)}</td><td>${number(total.prefillMs)} / ${number(total.decodeMs)}</td>
      <td>${number(total.inputTokens)} / ${number(total.outputTokens)}</td><td>${total.costUsd === null ? "unknown" : `$${total.costUsd.toFixed(4)}`}</td>
      <td>${total.maxTokensHits} / ${total.rejectedCalls} / ${total.failedCalls}</td><td>${total.formatPass}/${total.formatTotal}</td><td>${facts}</td><td>${total.unsupportedDetails}</td></tr>`;
  }).join("");
  const chunks = report.chunks.map((chunk, index) => `<section class="chunk">
    <div class="chunk-heading"><span class="index">${String(index + 1).padStart(2, "0")}</span><h2>${escapeHtml(chunk.label)} <small>Run ${chunk.run} · leaf source</small></h2></div>
    <div class="comparison"><article class="source"><h3>Source</h3><details><summary>Show source · ${number(chunk.source.length)} characters</summary><pre>${escapeHtml(chunk.source)}</pre></details></article>
    ${chunk.entries.map((entry) => `<article><h3>${escapeHtml(entry.endpoint)}</h3>${entry.calls.length === 0 ? '<p class="muted">No call for this source.</p>' : entry.calls.map((call, callIndex) => `
      <div class="call-meta">Call ${callIndex + 1}${call.aggressive ? " · aggressive" : ""} · ${number(call.latencyMs)} ms · ${call.unsupportedDetails.length} unsupported
      <br>Prefill / decode: ${number(call.prefillMs ?? null)} / ${number(call.decodeMs ?? null)} ms</div>
      ${call.attempts.map((attempt, index) => `<div class="call-meta">Attempt ${index + 1} · ${number(attempt.latencyMs)} ms${attempt.error ? ` · ${escapeHtml(attempt.error)}` : ""}</div>`).join("")}
      ${call.usages.map((usage) => `<div class="call-meta">Usage · ${escapeHtml(usage.provider)} · ${number(usage.inputTokens ?? null)} / ${number(usage.outputTokens ?? null)} tokens${usage.failed ? " · failed" : ""}</div>`).join("")}
      ${call.error ? `<p class="error">${escapeHtml(call.error)}</p>` : ""}
      <pre>${highlight(call.output ?? "No summary returned.", call.unsupportedDetails)}</pre>`).join("")}</article>`).join("")}</div>
    </section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Summarizer comparison · ${escapeHtml(report.sessionId)}</title><style>
:root{--paper:#f4f1e9;--ink:#202d28;--muted:#64736a;--line:#c9cec4;--accent:#186248;--mark:#ffe09a}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Georgia,'Times New Roman',serif}
main{max-width:1800px;margin:auto;padding:48px 36px}header{border-top:5px solid var(--accent);padding-top:22px;margin-bottom:36px}
.eyebrow,.index{font-family:'Courier New',monospace;color:var(--accent);font-size:12px;letter-spacing:.12em;text-transform:uppercase}
h1{font-size:clamp(30px,4vw,58px);font-weight:normal;letter-spacing:-.045em;margin:12px 0}p{line-height:1.6;max-width:100ch}
.notice{border-left:3px solid var(--accent);padding:8px 16px;background:#e6ebe1;font-size:14px}
.table-wrap{overflow:auto;margin:28px 0 48px}table{width:100%;border-collapse:collapse;font-family:'Courier New',monospace;font-size:12px;text-align:left}
thead{background:var(--ink);color:var(--paper)}th,td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}tbody th{color:var(--accent)}
small{display:block;font-weight:normal;color:var(--muted);font-size:12px;margin-top:6px}thead th{white-space:nowrap;font-weight:normal}
.chunk{border-top:1px solid var(--ink);margin-bottom:36px}.chunk-heading{display:flex;gap:18px;align-items:baseline;padding:18px 0}h2{font-size:22px;font-weight:normal;margin:0;overflow-wrap:anywhere}
.comparison{display:flex;overflow:auto;align-items:stretch;border:1px solid var(--line)}article{flex:1 0 300px;min-width:0;padding:20px;border-right:1px solid var(--line);background:#faf8f2}article:last-child{border-right:0}.source{background:#e9ede3}
h3{font-family:'Courier New',monospace;font-size:14px;margin:0 0 16px;overflow-wrap:anywhere}summary{cursor:pointer;font-family:'Courier New',monospace;font-size:12px;color:var(--accent);padding:8px 0}
pre{font-family:'Courier New',monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;max-height:65vh;overflow:auto}
.call-meta,.muted{font-family:'Courier New',monospace;font-size:11px;line-height:1.6;color:var(--muted)}mark{background:var(--mark);color:var(--ink);border-bottom:1px solid #b98108}.error{color:#973f28;font-size:13px}
footer{border-top:1px solid var(--line);padding-top:18px;color:var(--muted);font-size:13px}
@media(max-width:640px){main{padding:24px 16px}article{flex-basis:85vw}}@media print{main{padding:0}.comparison{overflow:visible;flex-wrap:wrap}pre{max-height:none}.table-wrap{overflow:visible}}
</style></head><body><main>
<header><div class="eyebrow">lcm / model measurements</div><h1>Summarizer comparison</h1>
<p>Session <strong>${escapeHtml(report.sessionId)}</strong> · ${report.candidates.length} candidates · Language ${escapeHtml(report.language ?? "unspecified")}<br>${escapeHtml(report.createdAt)}</p>
<p class="notice">${escapeHtml(report.notice)}</p></header>
<h2>Comparison</h2><div class="table-wrap"><table><thead><tr><th scope="col">Endpoint / model</th><th scope="col">Session / run</th><th scope="col">Calls</th><th scope="col">Latency ms</th><th scope="col">Prefill / decode ms</th><th scope="col">Input / output tokens</th><th scope="col">Cost USD</th><th scope="col">Cut off / rejected / failed</th><th scope="col">Format</th><th scope="col">Facts</th><th scope="col">Unsupported</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Leaf summaries beside their source</h2><p>Open a source to inspect it. Highlighted details appear nowhere in that call's source. This is a deterministic hint, not proof; preceding summary context can explain a highlight. Calls count engine invocations; timed provider-chain attempts include cap retries, with adapter retries included in their duration. Token and phase totals cover the usage reported by endpoints.</p>
${chunks || '<p class="muted">No leaf calls: the stored session did not meet the production compaction thresholds.</p>'}
<footer>Local report · Contains conversation content already scrubbed at capture. The project database was opened read-only; compaction ran in memory.</footer>
</main></body></html>`;
}
