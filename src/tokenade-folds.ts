import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readClaudeTranscriptDelta } from "./claude-transcript-reader.js";
import { compareStoredMessageContent, holdsTokenadePlaceholder, normalizeMessageContent, tokenadeFold } from "./message-content.js";
import { ConversationStore } from "./store/conversation-store.js";
import { storedInput } from "./store/tool-call-store.js";
import type { TranscriptToolCall } from "./tool-calls.js";
import { unfoldClaudeMessage, type ParsedMessage } from "./transcript.js";

/**
 * tokenade's cold-resume compaction replaces a stale tool output or input in a Claude Code
 * transcript with a placeholder naming a stash hash, and keeps the original only in its stash.
 * A row lcm first reads after the fold would store the placeholder; these restore the original.
 */

/** Reads a stashed original by the hash a placeholder names. */
export type StashReader = (hash: string) => string | undefined;

/**
 * tokenade's stash folder, resolved as tokenade 2 resolves it (`disclose::stash_dir`,
 * `platform::cache_dir`): `TOKENADE_STASH_DIR`, else `tokenade/stash` under the first set of
 * `XDG_CACHE_HOME`, `LOCALAPPDATA`, `HOME/.cache` and `USERPROFILE/AppData/Local`.
 */
export function tokenadeStashDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // tokenade treats a variable set to the empty string as unset.
  const set = (name: string) => env[name] || undefined;
  const home = set("HOME");
  const profile = set("USERPROFILE");
  const cache = set("XDG_CACHE_HOME") ?? set("LOCALAPPDATA")
    ?? (home ? join(home, ".cache") : profile ? join(profile, "AppData", "Local") : undefined);
  return set("TOKENADE_STASH_DIR") ?? (cache && join(cache, "tokenade", "stash"));
}

// What tokenade writes in place of the middle of an original over its stash size cap.
const STASH_TRUNCATED = "[tokenade:stash truncated — original was ";

/**
 * Reads the stash in `dir`. tokenade names each file `<hash>.<ext>`, the hash being the first 12
 * hex digits of the SHA-256 of the file's bytes: a file that does not hash to its name is refused,
 * so a changed stash format, a partial write or another file never stands for an original. So is
 * a copy tokenade cut at its size cap. The folder is listed once, on the first read.
 */
export function tokenadeStash(dir: string | undefined = tokenadeStashDir()): StashReader {
  let files: Map<string, string> | undefined;
  return (hash) => {
    if (dir === undefined) return undefined;
    files ??= stashFiles(dir);
    const file = files.get(hash);
    if (file === undefined) return undefined;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, file));
    } catch {
      return undefined;
    }
    if (createHash("sha256").update(bytes).digest("hex").slice(0, 12) !== hash) return undefined;
    const text = bytes.toString("utf8");
    return text.includes(STASH_TRUNCATED) ? undefined : text;
  };
}

function stashFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return files; // No stash: tokenade is absent, so every fold is kept.
  }
  for (const name of names) {
    const dot = name.indexOf(".");
    if (dot > 0) files.set(name.slice(0, dot), name);
  }
  return files;
}

/**
 * The original a folded value stands for. tokenade stashes its redacted copy of the whole value
 * and keeps an opening of the unredacted one, so the copy must begin with that opening.
 */
export function restoreFold(folded: string, read: StashReader): string | undefined {
  const fold = tokenadeFold(folded);
  const original = fold?.hash === undefined ? undefined : read(fold.hash);
  return original !== undefined && original.startsWith(fold?.head ?? "") ? original : undefined;
}

/**
 * `message` with every fold restored, and its tool calls, when stored in its place it still
 * matches the folded transcript row: otherwise the next capture could not verify stored history.
 */
function restoreMessage(message: ParsedMessage, scrub: (text: string) => string, read: StashReader):
  { message: ParsedMessage; toolCalls: TranscriptToolCall[] } | undefined {
  const parsed = unfoldClaudeMessage(message, (folded) => restoreFold(folded, read));
  const restored = parsed?.message;
  if (!restored || restored.role !== message.role) return undefined;
  const stored = normalizeMessageContent(scrub(restored.content));
  return compareStoredMessageContent(stored, message.content, scrub, true) === undefined
    ? undefined : { message: restored, toolCalls: parsed.toolCalls ?? [] };
}

/** Folded transcript rows a capture stored restored, and those it stored as the transcript holds them. */
export interface FoldedRows {
  expanded: number;
  kept: number;
}

/**
 * Replaces each folded message in `messages`, rows not yet stored, with its restored original,
 * and its tool calls with the restored message's. A message whose folds cannot all be restored is
 * kept as the transcript holds it.
 */
export function expandFoldedMessages(
  messages: ParsedMessage[], toolCalls: TranscriptToolCall[], scrub: (text: string) => string,
  read: StashReader = tokenadeStash(),
): { messages: ParsedMessage[]; toolCalls: TranscriptToolCall[]; folds: FoldedRows } {
  const folds: FoldedRows = { expanded: 0, kept: 0 };
  const restoredCalls = new Map<ParsedMessage, TranscriptToolCall[]>();
  const expanded = messages.map((message) => {
    if (!message.elided) return message;
    const restored = restoreMessage(message, scrub, read);
    if (!restored) {
      folds.kept++;
      return message;
    }
    folds.expanded++;
    restoredCalls.set(message, restored.toolCalls);
    return restored.message;
  });
  if (folds.expanded === 0) return { messages, toolCalls, folds };
  const replaced = new Set<ParsedMessage>();
  return {
    messages: expanded,
    folds,
    toolCalls: toolCalls.flatMap((call) => {
      const calls = call.message === undefined ? undefined : restoredCalls.get(call.message);
      if (call.message === undefined || calls === undefined) return [call];
      if (replaced.has(call.message)) return [];
      replaced.add(call.message);
      return calls;
    }),
  };
}

/** Sessions with a stored row or tool-call input that holds a tokenade placeholder, in id order. */
export function foldRepairCandidateIds(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT c.session_id AS sessionId FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE instr(m.content, '[tokenade:elided ') > 0
    UNION SELECT session_id FROM transcript_tool_calls WHERE instr(input, '[tokenade:elided ') > 0
    ORDER BY 1`).all() as Array<{ sessionId: string }>).map((row) => row.sessionId);
}

export interface FoldRepairPlan {
  sessionId: string;
  kind: "aligned" | "repairable" | "unavailable";
  /** Stored rows holding a folded row's placeholders, with the restored original's stored form. */
  rows: Array<{ messageId: number; storedContent: string; content: string; tokenCount: number }>;
  /** Stored tool-call inputs holding a folded input's placeholder, with the restored input's stored form. */
  calls: Array<{ callId: string; messageId: number; storedInput: string; input: string | null; inputBytes: number | null; truncated: number }>;
  /** Stored rows and inputs holding a placeholder that stay: no folded transcript row stored exactly so, or its original is not in the stash. */
  kept: number;
  reason?: string;
}

/**
 * Finds the stored rows and tool-call inputs a capture took from the transcript after tokenade
 * folded it, and their originals in the stash. A stored row qualifies only when it is exactly what
 * capture stores today for a folded transcript row, so an original lcm already holds is never
 * replaced, and a call input only when it is exactly what capture stores for the folded input.
 * Placeholders name a content hash, so equal folded rows restore to the same original wherever
 * they stand. Rows and calls are matched by content and call id, not position.
 */
export async function planFoldRepair(db: DatabaseSync, input: {
  sessionId: string; transcriptPath?: string; scrub: (text: string) => string; read?: StashReader;
}): Promise<FoldRepairPlan> {
  const { sessionId, scrub } = input;
  const storedRows = (db.prepare(`SELECT m.message_id AS messageId, m.content AS content FROM messages m
    JOIN conversations c ON c.conversation_id = m.conversation_id
    WHERE c.session_id = ? AND instr(m.content, '[tokenade:elided ') > 0`).all(sessionId) as Array<{ messageId: number; content: string }>)
    .filter((row) => holdsTokenadePlaceholder(row.content));
  const storedCalls = (db.prepare(`SELECT call_id AS callId, message_id AS messageId, input FROM transcript_tool_calls
    WHERE session_id = ? AND instr(input, '[tokenade:elided ') > 0`).all(sessionId) as Array<{ callId: string; messageId: number; input: string }>)
    .filter((call) => holdsTokenadePlaceholder(call.input));
  const plan: FoldRepairPlan = { sessionId, kind: "aligned", rows: [], calls: [], kept: storedRows.length + storedCalls.length };
  if (plan.kept === 0) return plan;
  if (!input.transcriptPath) return { ...plan, kind: "unavailable", reason: "no transcript file" };
  let transcript: Awaited<ReturnType<typeof readClaudeTranscriptDelta>>;
  try {
    transcript = await readClaudeTranscriptDelta(input.transcriptPath, { includeTrailingRecord: true });
  } catch {
    return { ...plan, kind: "unavailable", reason: "transcript is unreadable" };
  }
  const rowsByContent = new Map<string, Array<{ messageId: number; content: string }>>();
  for (const row of storedRows) rowsByContent.set(row.content, [...(rowsByContent.get(row.content) ?? []), row]);
  const callsById = new Map(storedCalls.map((call) => [call.callId, call]));
  const foldedCalls = new Map<ParsedMessage, TranscriptToolCall[]>();
  for (const call of transcript.toolCalls) {
    if (call.elided && call.name !== undefined && call.message !== undefined) {
      foldedCalls.set(call.message, [...(foldedCalls.get(call.message) ?? []), call]);
    }
  }
  const read = input.read ?? tokenadeStash();
  for (const message of transcript.messages) {
    if (!message.elided) continue;
    const key = rowsByContent.size > 0 ? normalizeMessageContent(scrub(message.content)) : undefined;
    const rows = key === undefined ? [] : rowsByContent.get(key) ?? [];
    const calls = (foldedCalls.get(message) ?? []).filter((call) => callsById.get(call.callId)?.input === storedInput(call, scrub).text);
    if (rows.length === 0 && calls.length === 0) continue;
    const restored = restoreMessage(message, scrub, read);
    if (!restored) continue;
    const content = normalizeMessageContent(scrub(restored.message.content));
    for (const row of rows) {
      if (row.content !== content) plan.rows.push({ messageId: row.messageId, storedContent: row.content, content, tokenCount: restored.message.tokenCount });
    }
    if (key !== undefined) rowsByContent.delete(key);
    for (const call of calls) {
      const stored = callsById.get(call.callId);
      const original = restored.toolCalls.find((candidate) => candidate.callId === call.callId && candidate.name !== undefined);
      if (!stored || !original) continue;
      const restoredInput = storedInput(original, scrub);
      if (restoredInput.text !== stored.input) {
        plan.calls.push({ callId: call.callId, messageId: stored.messageId, storedInput: stored.input,
          input: restoredInput.text, inputBytes: original.inputBytes ?? null, truncated: restoredInput.truncated });
      }
      callsById.delete(call.callId);
    }
  }
  plan.kept -= plan.rows.length + plan.calls.length;
  return { ...plan, kind: plan.rows.length + plan.calls.length > 0 ? "repairable" : "aligned" };
}

/** Applies a freshly made plan under the project's mutation lease; a row or input changed since fails it whole. */
export function applyFoldRepair(db: DatabaseSync, plan: FoldRepairPlan): number {
  if (plan.kind !== "repairable") return 0;
  return new ConversationStore(db).repairFoldedContent(plan.sessionId, plan.rows, plan.calls);
}
