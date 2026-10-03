import { createReadStream, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { validUuid } from "./identifiers.js";

const TOKENS = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g;
type Envelope = { cwd?: string; sessionId?: string; hasPayload: boolean };
type Ownership = { first?: string; current?: string; sessionIds: Set<string>; invalidIdentity: boolean; excluded: boolean };
type IdentityPolicy = { label: string; excluded: (cwd: string) => boolean };
type TranscriptOwnership = { cwd: string; excluded: boolean; sessionIds: Set<string>; invalidIdentity: boolean };

/** Inspect root metadata on every row without decoding message payloads. */
export async function transcriptOwnership(path: string, policy: IdentityPolicy): Promise<TranscriptOwnership> {
  requireMetadataFile(path);
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const state: Ownership = { sessionIds: new Set(), invalidIdentity: !validUuid(policy.label), excluded: false };
  try {
    for await (const line of lines) {
      inspectOwnership(line, state, policy);
    }
    return { cwd: owner(state), excluded: state.excluded, sessionIds: state.sessionIds,
      invalidIdentity: state.invalidIdentity || state.sessionIds.size === 0 };
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
function inspectOwnership(line: string, state: Ownership, policy: IdentityPolicy): void {
  if (!line.trim()) return;
  const row = envelope(line);
  inspectSession(row.sessionId, state, policy.label);
  state.current = row.cwd === undefined ? state.current : recordedCwd(row.cwd);
  state.first ??= state.current;
  if (state.current && policy.excluded(state.current)) state.excluded = true;
  if (!state.current && row.hasPayload) throw new Error("Missing row ownership");
}
function inspectSession(token: string | undefined, state: Ownership, label: string): void {
  if (token === undefined) return;
  const id: unknown = JSON.parse(token);
  if (validUuid(id)) state.sessionIds.add(id);
  else state.invalidIdentity = true;
  if (id !== label) state.invalidIdentity = true;
}
function envelope(line: string): Envelope {
  if (!line.trimStart().startsWith("{")) return { hasPayload: false };
  const tokens = line.matchAll(TOKENS);
  let depth = 0;
  const row: Envelope = { hasPayload: false };
  for (const [token] of tokens) {
    if (depth !== 1 || !token.startsWith('"')) { depth += nesting(token); continue; }
    const field = rootField(token, tokens);
    if (field.key === "cwd") row.cwd = field.value;
    if (field.key === "sessionId") row.sessionId = field.value;
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
