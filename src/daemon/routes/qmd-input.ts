import type { QmdSearchRequest } from "../../search/qmd-protocol.js";

function strings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

export function qmdSearchInput(input: Record<string, unknown>, cwd?: string): QmdSearchRequest {
  if (!cwd) throw new Error("QMD requires a project cwd");
  if (typeof input.query !== "string" || !input.query.trim()) throw new Error("query must be nonempty text");
  const limit = input.limit ?? 5;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("QMD limit must be an integer from 1 to 100");
  }
  const mode = input.mode ?? "lexical";
  if (mode !== "lexical" && mode !== "hybrid") throw new Error("QMD mode must be lexical or hybrid");
  const layers = strings(input.layers, "layers");
  if (layers?.some(layer => layer !== "episodic" && layer !== "promoted")) throw new Error("Invalid memory layer");
  return { cwd, query: input.query, limit, mode, layers, tags: strings(input.tags, "tags") };
}
