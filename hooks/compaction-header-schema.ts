export const COMPACTION_HEADER_SECTIONS = ["intent", "instructionsInForce", "decisions", "taskState", "procedure", "nextSteps", "openThreads", "files", "errors"] as const;
export type HeaderSource = string | { quote: string };
export type HeaderProvenance = "authorized by the user" | "proposed by the assistant" | "observed" | "unresolved";
export type WorkingItem = { text: string; sources: HeaderSource[]; state?: "reported" | "confirmed" | "unknown" };
export type CompactionHeader = {
  version: 2; intent: WorkingItem[]; instructionsInForce: { sources: string[] }[];
  decisions: (WorkingItem & { supersedes?: HeaderSource[] })[];
  taskState: (WorkingItem & { status: "done" | "in progress" | "blocked"; provenance: HeaderProvenance })[];
  procedure: WorkingItem[]; nextSteps: (WorkingItem & { provenance: HeaderProvenance })[];
  openThreads: WorkingItem[]; files: (WorkingItem & { status: string })[]; errors: (WorkingItem & { fix: string })[];
};
export type CompactionHeaderItem = CompactionHeader[typeof COMPACTION_HEADER_SECTIONS[number]][number];
export function compactionHeaderItems(header: CompactionHeader): CompactionHeaderItem[] {
  return COMPACTION_HEADER_SECTIONS.flatMap<CompactionHeaderItem>(key => header[key]);
}
const PROVENANCE = ["authorized by the user", "proposed by the assistant", "observed", "unresolved"];
export function validModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.exec(value)?.[0] === value;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
export function validHeaderSource(value: unknown): value is HeaderSource {
  if (record(value)) return only(value, ["quote"]) && text(value.quote);
  if (typeof value !== "string") return false;
  const match = /^\[(?:excerpt:[A-Za-z0-9_-]{1,140}|sum:sum_[A-Za-z0-9_-]{1,136}|raw:[A-Za-z0-9_-]{1,140}:[1-9]\d*)\]$/.exec(value);
  if (match?.[0] !== value) return false;
  const raw = /^\[raw:[A-Za-z0-9_-]+:([1-9]\d*)\]$/.exec(value);
  return !raw || Number.isSafeInteger(Number(raw[1]));
}
function sourced(value: unknown): value is Record<string, unknown> & { sources: HeaderSource[] } {
  return record(value) && Array.isArray(value.sources) && value.sources.length > 0 && value.sources.every(validHeaderSource);
}
function working(value: unknown): value is Record<string, unknown> & WorkingItem {
  if (!sourced(value) || !text(value.text)) return false;
  if (value.state !== undefined && !["reported", "confirmed", "unknown"].includes(value.state as string)) return false;
  const summaryOnly = value.sources.every(source => typeof source === "string" && source.startsWith("[sum:"));
  return !summaryOnly || value.state === "reported";
}
function instruction(value: unknown): boolean {
  return sourced(value) && only(value, ["sources"]) && value.sources.every(source => typeof source === "string" && source.startsWith("[excerpt:"));
}
const ITEM_KEYS = ["text", "sources", "state"];
const plain = (value: unknown): boolean => working(value) && only(value, ITEM_KEYS);
function decision(value: unknown): boolean {
  if (!working(value) || !only(value, [...ITEM_KEYS, "supersedes"])) return false;
  return value.supersedes === undefined || Array.isArray(value.supersedes) && value.supersedes.every(validHeaderSource);
}
function task(value: unknown): boolean {
  return working(value) && only(value, [...ITEM_KEYS, "status", "provenance"]) &&
    ["done", "in progress", "blocked"].includes(value.status as string) && PROVENANCE.includes(value.provenance as string);
}
function nextStep(value: unknown): boolean {
  return working(value) && only(value, [...ITEM_KEYS, "provenance"]) && PROVENANCE.includes(value.provenance as string);
}
function file(value: unknown): boolean { return working(value) && only(value, [...ITEM_KEYS, "status"]) && text(value.status); }
function error(value: unknown): boolean { return working(value) && only(value, [...ITEM_KEYS, "fix"]) && text(value.fix); }
const validators: Record<typeof COMPACTION_HEADER_SECTIONS[number], (value: unknown) => boolean> = {
  intent: plain, instructionsInForce: instruction, decisions: decision, taskState: task, procedure: plain,
  nextSteps: nextStep, openThreads: plain, files: file, errors: error,
};
export function validCompactionHeader(value: unknown): value is CompactionHeader {
  if (!record(value) || value.version !== 2 || !only(value, ["version", ...COMPACTION_HEADER_SECTIONS])) return false;
  return COMPACTION_HEADER_SECTIONS.every(key => Array.isArray(value[key]) && value[key].every(validators[key]));
}
/** String identifiers and typed state retain identity; only free text is mapped. */
export function mapCompactionHeaderText(value: CompactionHeader, map: (text: string) => string): CompactionHeader {
  const result = JSON.parse(JSON.stringify(value)) as CompactionHeader;
  for (const key of COMPACTION_HEADER_SECTIONS) for (const item of result[key]) {
    mapWorkingItem({ item, file: key === "files" }, map);
  }
  return result;
}
function mapWorkingItem({ item, file }: { item: CompactionHeaderItem; file: boolean }, map: (text: string) => string): void {
  item.sources = item.sources.map(source => mapSourceQuote(source, map)) as typeof item.sources;
  if ("text" in item) item.text = map(item.text);
  if ("fix" in item) item.fix = map(item.fix);
  if (file && "status" in item) item.status = map(item.status) as typeof item.status;
  if ("supersedes" in item) item.supersedes = item.supersedes?.map(source => mapSourceQuote(source, map));
}
function mapSourceQuote(source: HeaderSource, map: (text: string) => string): HeaderSource {
  return typeof source === "string" ? source : { quote: map(source.quote) };
}
