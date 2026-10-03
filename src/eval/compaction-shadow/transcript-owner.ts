import { createReadStream, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const TOKENS = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g;
type Envelope = { cwd?: string; hasPayload: boolean };
type Ownership = { first?: string; current?: string };

/** Inspect root metadata on every row without decoding message payloads. */
export async function transcriptOwnership(path: string, excluded: (cwd: string) => boolean): Promise<{ cwd: string; excluded: boolean }> {
  requireMetadataFile(path);
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const state: Ownership = {};
  try {
    for await (const line of lines) {
      if (inspectOwnership(line, state, excluded)) return { cwd: owner(state), excluded: true };
    }
    return { cwd: owner(state), excluded: false };
  } finally { lines.close(); input.destroy(); }
}
function requireMetadataFile(path: string): void {
  const stat = lstatSync(path);
  if (!isAbsolute(path) || !stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid transcript path");
}
function owner(state: Ownership): string {
  if (!state.first) throw new Error("Missing transcript ownership");
  return state.first;
}
function inspectOwnership(line: string, state: Ownership, excluded: (cwd: string) => boolean): boolean {
  if (!line.trim()) return false;
  const row = envelope(line);
  state.current = row.cwd ?? state.current;
  state.first ??= state.current;
  if (state.current && excluded(state.current)) return true;
  if (!state.current && row.hasPayload) throw new Error("Missing row ownership");
  return false;
}
function envelope(line: string): Envelope {
  if (!line.trimStart().startsWith("{")) throw new Error("Invalid transcript envelope");
  const tokens = line.matchAll(TOKENS);
  let depth = 0;
  const row: Envelope = { hasPayload: false };
  for (const [token] of tokens) {
    if (depth !== 1 || !token.startsWith('"')) { depth += nesting(token); continue; }
    const field = rootField(token, tokens);
    if (field.key === "cwd") row.cwd = recordedCwd(field.value);
    row.hasPayload ||= ["message", "content"].includes(field.key);
    depth += nesting(field.value);
  }
  return row;
}
function rootField(key: string, tokens: RegExpStringIterator<RegExpExecArray>): { key: string; value: string } {
  const colon = tokens.next().value?.[0], value = tokens.next().value?.[0];
  if (colon !== ":" || value === undefined) throw new Error("Invalid transcript metadata");
  return { key: JSON.parse(key), value };
}
function recordedCwd(token: string): string {
  const cwd: unknown = JSON.parse(token);
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Invalid row cwd");
  return cwd;
}
function nesting(token: string): number {
  if (["{", "["].includes(token)) return 1;
  return ["}", "]"].includes(token) ? -1 : 0;
}
