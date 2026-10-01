import { createReadStream, existsSync, lstatSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { openStandaloneLcmConnection } from "../db/connection.js";
import { PromotedStore } from "../db/promoted.js";
import { findSessionFiles, type DiscoveredSessionFile } from "../import.js";
import { findCodexSessionFiles } from "../codex-transcript.js";
import type { LcmPaths } from "../lcm-paths.js";
import { normalizeMessageContent } from "../message-content.js";
import { requireOffline } from "./store-hygiene.js";

function normalized(text: string): string {
  return normalizeMessageContent(text).normalize("NFC").replace(/\s+/g, " ").trim();
}

function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => join(path, entry.name)).sort();
}

function claudeFiles(projectDir: string): DiscoveredSessionFile[] {
  // Import selects a canonical copy; repair needs evidence from the nested copies too.
  return [
    ...findSessionFiles(projectDir),
    ...directories(projectDir).flatMap(dir => {
      const sessionId = basename(dir);
      const path = join(dir, `${sessionId}.jsonl`);
      if (!existsSync(path)) return [];
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ path, sessionId, mtime: stat.mtimeMs }] : [];
    }),
  ];
}

type ToolCall = { type?: string; name?: unknown; input?: unknown; arguments?: unknown };
type TranscriptRecord = { type?: string; message?: { content?: ToolCall[] }; payload?: ToolCall };

function storeText(call: ToolCall): string | undefined {
  if (typeof call?.name !== "string" || !call.name.endsWith("lcm_store")) return;
  let input = call.arguments ?? call.input;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { return; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const args = input as { text?: unknown; content?: unknown };
  const text = args.text ?? args.content;
  return typeof text === "string" ? text : undefined;
}

async function storeCalls(files: DiscoveredSessionFile[]): Promise<Map<string, Set<string>>> {
  const matches = new Map<string, Set<string>>();
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record: TranscriptRecord;
        try { record = JSON.parse(line); } catch { continue; }
        const calls = record?.type === "assistant" && Array.isArray(record.message?.content)
          ? record.message.content.filter(call => call?.type === "tool_use")
          : record?.type === "response_item" && ["function_call", "custom_tool_call"].includes(record.payload?.type ?? "")
            ? [record.payload!] : [];
        for (const call of calls) {
          const text = storeText(call);
          if (typeof text !== "string" || !normalized(text)) continue;
          const key = normalized(text);
          const sessions = matches.get(key) ?? new Set<string>();
          sessions.add(file.sessionId);
          matches.set(key, sessions);
        }
      }
    } finally { lines.close(); }
  }
  return matches;
}

/** Raw store-call evidence; preview is read-only and explicit apply requires held offline stores. */
export async function repairManualAttribution(paths: LcmPaths, apply = false): Promise<string> {
  if (apply) requireOffline(paths);
  const files = [
    ...directories(join(homedir(), ".claude", "projects")).flatMap(claudeFiles),
    ...findCodexSessionFiles(join(homedir(), ".codex", "sessions")),
    ...findCodexSessionFiles(join(homedir(), ".codex", "archived_sessions")),
  ];
  const matches = await storeCalls(files);
  const output = [apply ? "Manual memory attribution" : "[dry-run] Manual memory attribution"];
  let applied = 0;
  for (const dir of directories(paths.projectsDir)) {
    const dbPath = join(dir, "db.sqlite");
    if (!existsSync(dbPath)) continue;
    const db = openStandaloneLcmConnection(dbPath, { readOnly: true });
    const repairs: Array<{ id: string; sessionId: string }> = [];
    try {
      for (const row of new PromotedStore(db).getAll().filter(row => row.session_id === "manual")) {
        const sessions = [...(matches.get(normalized(row.content)) ?? [])].sort();
        if (sessions.length === 0) output.push(`${dbPath} ${row.id}: unmatched`);
        if (sessions.length === 1) {
          output.push(`${dbPath} ${row.id}: attributable -> ${sessions[0]}`);
          repairs.push({ id: row.id, sessionId: sessions[0] });
        }
        if (sessions.length > 1) output.push(`${dbPath} ${row.id}: ambiguous -> ${sessions.join(", ")}`);
      }
    } finally { db.close(); }
    if (!apply || repairs.length === 0) continue;
    requireOffline(paths);
    const writable = new DatabaseSync(dbPath);
    try {
      const backup = `${dbPath}.bak-manual-attribution-${randomUUID()}`;
      writable.prepare("VACUUM INTO ?").run(backup);
      output.push(`Backup: ${backup}`);
      const store = new PromotedStore(writable);
      store.transaction(() => {
        for (const repair of repairs) {
          if (store.attributeManual(repair.id, repair.sessionId)) applied++;
        }
      });
    } finally { writable.close(); }
  }
  output.push(apply ? `Applied ${applied} memory attribution(s).` : "Preview only; use --apply while the daemon is held offline.");
  return output.join("\n");
}
