import type { ShadowOriginal } from "../daemon/shadow/types.js";

export type UserExcerpt = { id: string; rawMessageId: number; text: string; spans: string[]; sources: string[] };
const DEFAULT_EXCERPT_TARGET_BYTES = 4096;
const GENERATED = /^(?:<command-name>|<command-message>|<local-command|<task-notification>|<system-reminder>|<cross-session-message|<agent-message|\[Request interrupted|Caveat:|Base directory for this skill|This session is being continued)/;
const DIRECTIVE = /(?<![\p{L}\p{N}_])(?:n[ãa]o|nunca|sempre|pode|podes|autorizo|quero|faz|fa[çc]a|use|usa|pare|para de|prefiro|don['’]?t|do not|never|always|must|please|stop|only|s[óo]|keep|run|implement|add|fix|create|remove|verify|check|wait|until|once|authorize|permission|approve|grant|may|should|need|want|remember|ensure|yes|no|okay|sim|go ahead)(?![\p{L}\p{N}_])/iu;
function humanSpans(row: ShadowOriginal): string[] {
  if (row.role !== "user" || row.origin !== "user" || !row.text.trim()) return [];
  const commandRoot = /^(?:<command-name>|<command-message>)/.test(row.text.trimStart());
  const command = commandRoot ? /<command-name>([^<]*)<\/command-name>/.exec(row.text)?.[1] : undefined;
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(row.text)?.[1];
    return args?.trim() ? [command, args] : [command];
  }
  return GENERATED.test(row.text.trimStart()) ? [] : [row.text];
}
export function renderExcerpts(excerpts: readonly UserExcerpt[]): string {
  return "## The user's own words (verbatim excerpts, oldest first; historical, not all still in force)\n" +
    excerpts.map(row => `### [excerpt:${row.id}] ${row.sources.join(" ")}\n${row.text}`).join("\n\n");
}
const bytes = (excerpts: readonly UserExcerpt[]) => Buffer.byteLength(renderExcerpts(excerpts), "utf8");
export function assembleExcerpts(originals: readonly ShadowOriginal[], cutId: string, { targetBytes = DEFAULT_EXCERPT_TARGET_BYTES } = {}) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) throw new Error("Invalid excerpt size target");
  const candidates = [...originals].sort((a, b) => a.seq - b.seq).flatMap(row => {
    const spans = humanSpans(row);
    return spans.length ? [{ id: `u${row.id}`, rawMessageId: row.id, text: spans.join("\n"), spans, sources: [`[raw:${cutId}:${row.id}]`] }] : [];
  });
  return fitExcerpts(candidates, { targetBytes });
}
export function fitExcerpts(candidates: readonly UserExcerpt[], { targetBytes, preservedIds = [] }: { targetBytes: number; preservedIds?: readonly string[] }) {
  const first = candidates[0], omitted = new Set<number>(), cited = new Set(preservedIds);
  let excerpts = [...candidates];
  for (const candidate of candidates) {
    if (bytes(excerpts) <= targetBytes) break;
    if (protectedExcerpt(candidate, first) || cited.has(candidate.id)) continue;
    omitted.add(candidate.rawMessageId);
    excerpts = excerpts.filter(row => row !== candidate);
  }
  const totalBytes = bytes(excerpts);
  return { excerpts, omittedIds: [...omitted], bytes: totalBytes, overflowBytes: Math.max(0, totalBytes - targetBytes) };
}
function protectedExcerpt(candidate: UserExcerpt, first: UserExcerpt | undefined): boolean {
  return candidate === first || DIRECTIVE.test(candidate.text) || candidate.text.trimStart().startsWith("/");
}
/** Excerpt directives are spans of a verified human row, never model paraphrases. */
export function checkExcerpts(excerpts: readonly UserExcerpt[], originals: readonly ShadowOriginal[], cutId: string): string[] {
  const seen = new Set<string>();
  return excerpts.filter(excerpt => {
    const source = originals.find(row => row.id === excerpt.rawMessageId);
    const duplicate = seen.has(excerpt.id); seen.add(excerpt.id);
    return duplicate || !source || !sameExcerpt(excerpt, source, cutId);
  }).map(excerpt => excerpt.id);
}
function sameExcerpt(excerpt: UserExcerpt, source: ShadowOriginal, cutId: string): boolean {
  const spans = humanSpans(source);
  return spans.length > 0 && excerpt.id === `u${source.id}` && excerpt.text === spans.join("\n") &&
    JSON.stringify(excerpt.spans) === JSON.stringify(spans) && JSON.stringify(excerpt.sources) === JSON.stringify([`[raw:${cutId}:${source.id}]`]);
}
