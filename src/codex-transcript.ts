/**
 * Parser for Codex CLI session transcript files.
 *
 * Codex stores sessions in ~/.codex/sessions/<session-id>/<session-id>.jsonl
 * and archives them in ~/.codex/archived_sessions/<name>.jsonl.
 *
 * Each JSONL line is an event object with a top-level `type` and `payload`:
 *
 *   { type: "session_meta", payload: { id, cwd, ... } }
 *   { type: "response_item", payload: { type: "message", role: "user"|"assistant"|..., content: [...] } }
 *   { type: "event_msg", payload: { ... } }
 *   ...
 *
 * Content blocks for user messages use `type: "input_text"` and for assistant
 * messages use `type: "output_text"` (both carry a `text` string field).
 */

import { readdirSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { estimateTokens } from "./transcript.js";
import type { ParsedMessage } from "./transcript.js";

// ---------------------------------------------------------------------------
// Types matching the Codex JSONL event format
// ---------------------------------------------------------------------------

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface CodexResponseItemPayload {
  type?: string;
  role?: string;
  content?: string | CodexContentBlock[];
}

interface CodexSessionMetaPayload {
  id?: string;
  cwd?: string;
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: CodexResponseItemPayload | CodexSessionMetaPayload | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function extractCodexText(content: string | CodexContentBlock[] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      // Codex uses input_text (user) and output_text (assistant)
      if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
        return b.text;
      }
      // Plain text fallback
      if (b.type === "text" && typeof b.text === "string") {
        return b.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

/**
 * Parse a Codex JSONL transcript file into the standard ParsedMessage format.
 * Returns an empty array on any read or parse error.
 */
export function parseCodexTranscript(transcriptPath: string): ParsedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const messages: ParsedMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: CodexLine;
    try {
      obj = JSON.parse(trimmed) as CodexLine;
    } catch {
      continue;
    }

    // Only response_item lines carry user/assistant messages
    if (obj.type !== "response_item") continue;

    const payload = obj.payload as CodexResponseItemPayload | undefined;
    if (!payload || payload.type !== "message") continue;

    const role = payload.role;
    if (!role || !["user", "assistant"].includes(role)) continue;

    const content = extractCodexText(payload.content);
    if (!content.trim()) continue;

    messages.push({ role, content, tokenCount: estimateTokens(content) });
  }

  return messages;
}

/**
 * Extract the working directory from a Codex session JSONL file.
 * Returns undefined if the session_meta line cannot be found/parsed.
 */
export function extractCodexSessionCwd(transcriptPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return undefined;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as CodexLine;
      if (obj.type === "session_meta") {
        const meta = obj.payload as CodexSessionMetaPayload | undefined;
        if (typeof meta?.cwd === "string" && meta.cwd) return meta.cwd;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

export interface CodexSessionFile {
  path: string;
  sessionId: string;
  mtime: number;
}

/**
 * Discover Codex transcript files under a root directory.
 *
 * Supported layouts:
 *   - Flat:  <root>/<name>.jsonl         (archived_sessions/)
 *   - Nested: <root>/<id>/<id>.jsonl     (sessions/ layout)
 */
export function findCodexSessionFiles(rootDir: string): CodexSessionFile[] {
  const files: CodexSessionFile[] = [];
  if (!existsSync(rootDir)) return files;

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    // Flat layout: rootDir/<name>.jsonl
    if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl")) {
      try {
        const full = join(rootDir, entry.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue; // skip symlinks
        files.push({
          path: full,
          sessionId: basename(entry.name, ".jsonl"),
          mtime: st.mtimeMs,
        });
      } catch {
        // skip unreadable entries
      }
      continue;
    }

    // Nested layout: rootDir/<id>/<id>.jsonl
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = join(rootDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(nested)) {
        try {
          const st = lstatSync(nested);
          if (st.isSymbolicLink()) {
            // skip symlinks
          } else if (st.isFile()) {
            files.push({
              path: nested,
              sessionId: entry.name,
              mtime: st.mtimeMs,
            });
          }
        } catch {
          // skip
        }
      }
    }
  }

  return files.sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Collect all Codex transcript files from a Codex home directory.
 *
 * Searches:
 *   - <codexDir>/archived_sessions/*.jsonl  (flat layout)
 *   - <codexDir>/sessions/<id>/<id>.jsonl   (nested layout)
 *
 * Defaults to ~/.codex when codexDir is omitted.
 */
export function findAllCodexTranscripts(codexDir?: string): CodexSessionFile[] {
  const root = codexDir ?? join(homedir(), ".codex");
  const results: CodexSessionFile[] = [];

  // Archived sessions (flat)
  results.push(...findCodexSessionFiles(join(root, "archived_sessions")));

  // Active sessions (nested)
  results.push(...findCodexSessionFiles(join(root, "sessions")));

  // De-duplicate by sessionId (flat archive wins over sessions/)
  const seen = new Map<string, CodexSessionFile>();
  for (const f of results) {
    if (!seen.has(f.sessionId)) seen.set(f.sessionId, f);
  }

  return [...seen.values()].sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}
