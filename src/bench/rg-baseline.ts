import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type GrepDocument = { id: string; text: string };
export type PreparedRgCorpus = {
  path: string;
  spans: { id: string; start: number; end: number }[];
  fingerprint: string;
  bytes: number;
  documents: number;
};
export type RgSearchResult = {
  hits: { id: string; matchedTerms: number; occurrences: number }[];
  elapsedMs: number;
  matchedLines: number;
};

/** Preserve source text verbatim; searchable content contains no identity metadata. */
export async function prepareRgCorpus(documents: GrepDocument[], directory: string): Promise<PreparedRgCorpus> {
  if (new Set(documents.map(document => document.id)).size !== documents.length) {
    throw new Error("Ripgrep corpus requires unique source IDs");
  }
  await mkdir(directory, { recursive: true });
  const corpus: PreparedRgCorpus = { path: join(directory, "corpus.txt"), spans: [], fingerprint: "", bytes: 0, documents: documents.length };
  const hash = createHash("sha256");
  const file = await open(corpus.path, "w");
  try {
    for (const document of documents) {
      const bytes = Buffer.from(document.text, "utf8");
      corpus.spans.push({ id: document.id, start: corpus.bytes, end: corpus.bytes + bytes.length });
      hash.update(JSON.stringify([document.id, bytes.length])).update("\n").update(bytes);
      await file.writeFile(bytes);
      await file.writeFile("\n");
      corpus.bytes += bytes.length + 1;
    }
  } finally {
    await file.close();
  }
  corpus.fingerprint = hash.digest("hex");
  await writeFile(join(directory, "corpus.metadata.json"), JSON.stringify(corpus, null, 2));
  return corpus;
}

function sourceAt(corpus: PreparedRgCorpus, offset: number): string | undefined {
  let low = 0;
  let high = corpus.spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = corpus.spans[middle];
    if (offset < span.start) high = middle - 1;
    else if (offset >= span.end) low = middle + 1;
    else return span.id;
  }
  return undefined;
}

function literalPattern(term: string): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

/** Real rg candidate retrieval, followed by a deterministic, independent literal ranking. */
export async function searchRg(
  corpus: PreparedRgCorpus, terms: string[], limit: number, options: { binary?: string } = {},
): Promise<RgSearchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Ripgrep limit must be a positive safe integer");
  if (terms.some(term => !term || /[\r\n\0]/.test(term))) throw new Error("Ripgrep terms must be nonempty single-line literals without NUL");
  const uniqueTerms = [...new Set(terms.map(term => term.toLowerCase()))];
  if (!uniqueTerms.length) throw new Error("Ripgrep requires at least one literal term");
  const patterns = uniqueTerms.map(literalPattern);
  const started = performance.now();
  const child = spawn(options.binary ?? "rg", [
    "--json", "--text", "--ignore-case", "--fixed-strings", "--no-config",
    ...uniqueTerms.map(term => `--regexp=${term}`), "--", corpus.path,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const exited = new Promise<{ code: number | null; error?: Error }>(resolve => {
    child.once("error", error => resolve({ code: null, error }));
    child.once("close", code => resolve({ code }));
  });
  const sources = new Map<string, { terms: Set<number>; occurrences: number }>();
  let matchedLines = 0;
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const event = JSON.parse(line);
      if (event.type !== "match") continue;
      const id = sourceAt(corpus, event.data.absolute_offset);
      if (id === undefined) throw new Error("Ripgrep match outside corpus source offsets");
      const text = event.data.lines.text ?? Buffer.from(event.data.lines.bytes, "base64").toString("utf8");
      const source = sources.get(id) ?? { terms: new Set<number>(), occurrences: 0 };
      patterns.forEach((pattern, index) => {
        const count = [...text.matchAll(pattern)].length;
        if (count) source.terms.add(index);
        source.occurrences += count;
      });
      sources.set(id, source);
      matchedLines++;
    }
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  const result = await exited;
  if (result.error) throw new Error(`Cannot execute ripgrep: ${result.error.message}`, { cause: result.error });
  if (result.code !== 0 && result.code !== 1) throw new Error(`Ripgrep failed (exit ${result.code}): ${stderr.trim()}`);
  const hits = [...sources].map(([id, value]) => ({ id, matchedTerms: value.terms.size, occurrences: value.occurrences }));
  hits.sort((a, b) => b.matchedTerms - a.matchedTerms || b.occurrences - a.occurrences || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hits: hits.slice(0, limit), elapsedMs: performance.now() - started, matchedLines };
}
