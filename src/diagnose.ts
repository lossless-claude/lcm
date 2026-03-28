import { createReadStream, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { cwdToProjectHash, findSessionFiles } from "./import.js";

const RELEVANT_COMMAND_RE = /(^|[\s"'`])(?:[^"'`\s]+\/)?(?:lcm|lossless-claude)(?=$|[\s"'`])/;
const OLD_BINARY_RE = /(^|[\s"'`])(?:[^"'`\s]+\/)?lossless-claude(?=$|[\s"'`])/;
const ERROR_WINDOW_LINES = 5;

export interface DiagnosticError {
  type: "hook-error" | "mcp-disconnect" | "old-binary" | "duplicate-hook";
  hookEvent?: string;
  command?: string;
  timestamp?: string;
  details?: string;
  count: number;
}

export interface SessionDiagnostic {
  sessionId: string;
  sessionName?: string;
  filePath: string;
  errors: DiagnosticError[];
  lastTimestamp?: string;
}

export interface DiagnoseResult {
  sessionsScanned: number;
  sessionsWithErrors: number;
  totalErrors: number;
  totalWarnings: number;
  sessions: SessionDiagnostic[];
  mostCommon?: { type: string; count: number };
}

export interface DiagnoseOptions {
  all?: boolean;
  days?: number;
  verbose?: boolean;
  cwd?: string;
  /** Override ~/.claude/projects path — used in tests only */
  _claudeProjectsDir?: string;
  /** Override Date.now() — used in tests only */
  _nowMs?: number;
}

interface PendingHook {
  command: string;
  hookEvent?: string;
  lineNumber: number;
  parentToolUseID?: string;
  timestamp?: string;
}

interface DuplicateGroup {
  command: string;
  count: number;
  hookEvent?: string;
  timestamp?: string;
}

interface ScanSessionResult extends SessionDiagnostic {
  mtimeMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function truncate(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item)) {
          return getString(item.text) ?? getString(item.content);
        }
        return undefined;
      })
      .filter((part): part is string => Boolean(part));
    if (parts.length > 0) return truncate(parts.join(" "));
  }
  if (isRecord(value)) {
    return getString(value.text) ?? getString(value.content);
  }
  return undefined;
}

function isRelevantHookCommand(command?: string): command is string {
  return typeof command === "string" && RELEVANT_COMMAND_RE.test(command);
}

function isOldBinaryCommand(command?: string): command is string {
  return typeof command === "string" && OLD_BINARY_RE.test(command);
}

function isWarning(error: DiagnosticError): boolean {
  return error.type === "old-binary";
}

function buildErrorKey(error: Omit<DiagnosticError, "count">): string {
  return [
    error.type,
    error.hookEvent ?? "",
    error.command ?? "",
  ].join("\u001f");
}

function addAggregatedError(
  aggregate: Map<string, DiagnosticError>,
  error: Omit<DiagnosticError, "count">,
  increment = 1
) {
  const key = buildErrorKey(error);
  const existing = aggregate.get(key);
  if (existing) {
    existing.count += increment;
    existing.timestamp = existing.timestamp ?? error.timestamp;
    existing.details = existing.details ?? error.details;
    return;
  }
  aggregate.set(key, { ...error, count: increment });
}

function getEntryTimestamp(entry: Record<string, unknown>): string | undefined {
  return getString(entry.timestamp);
}

function getSystemContent(entry: Record<string, unknown>): string | undefined {
  return getString(entry.content) ?? extractText(entry.message);
}

function getToolUseID(value: Record<string, unknown>): string | undefined {
  return (
    getString(value.parentToolUseID) ??
    getString(value.toolUseID) ??
    getString(value.parent_tool_use_id) ??
    getString(value.tool_use_id)
  );
}

function getEntryToolUseIDs(entry: Record<string, unknown>): string[] {
  const toolUseIDs = new Set<string>();
  const topLevelToolUseID = getToolUseID(entry);
  if (topLevelToolUseID) toolUseIDs.add(topLevelToolUseID);

  if (isRecord(entry.message) && Array.isArray(entry.message.content)) {
    for (const item of entry.message.content) {
      if (!isRecord(item)) continue;
      const toolUseID = getToolUseID(item);
      if (toolUseID) toolUseIDs.add(toolUseID);
    }
  }

  return Array.from(toolUseIDs);
}

function getToolResultError(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "user" || !isRecord(entry.message)) return undefined;
  const content = entry.message.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "tool_result" && item.is_error === true) {
      return extractText(item.content) ?? getString(entry.toolUseResult) ?? "tool_result reported an error";
    }
  }
  return undefined;
}

function getStructuredHookError(entry: Record<string, unknown>): string | undefined {
  const toolError = getToolResultError(entry);
  if (toolError) return toolError;

  const stderr = getString(entry.stderr);
  if (stderr) return `stderr: ${truncate(stderr)}`;

  const exitCode = entry.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return `exit code ${exitCode}`;
  }

  const exitCodeAlt = entry.exit_code;
  if (typeof exitCodeAlt === "number" && exitCodeAlt !== 0) {
    return `exit code ${exitCodeAlt}`;
  }

  if (entry.type === "system") {
    const content = getSystemContent(entry);
    const level = getString(entry.level);
    if (
      content &&
      (level === "error" ||
        /<local-command-stderr>/i.test(content) ||
        /\b(stderr|timed out|timeout|failed|failure|error|non-zero exit|exit code)\b/i.test(content))
    ) {
      return truncate(content);
    }
  }

  return undefined;
}

function getMcpDisconnect(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "system") return undefined;
  const content = getSystemContent(entry);
  if (!content) return undefined;
  const lower = content.toLowerCase();
  if (!lower.includes("disconnect")) return undefined;
  if (!lower.includes("lcm") && !lower.includes("lossless-claude")) return undefined;
  return truncate(content);
}

function prunePendingHooks(pending: PendingHook[], lineNumber: number): PendingHook[] {
  return pending.filter((hook) => lineNumber - hook.lineNumber <= ERROR_WINDOW_LINES);
}

function matchPendingHook(
  pending: PendingHook[],
  entry: Record<string, unknown>,
  lineNumber: number
): PendingHook | undefined {
  const currentToolUseIDs = getEntryToolUseIDs(entry);

  if (currentToolUseIDs.length > 0) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const hook = pending[i];
      if (lineNumber - hook.lineNumber > ERROR_WINDOW_LINES) continue;
      if (hook.parentToolUseID && currentToolUseIDs.includes(hook.parentToolUseID)) {
        pending.splice(i, 1);
        return hook;
      }
    }
  }

  for (let i = pending.length - 1; i >= 0; i--) {
    const hook = pending[i];
    if (lineNumber - hook.lineNumber > ERROR_WINDOW_LINES) continue;
    if (currentToolUseIDs.length === 0 || !hook.parentToolUseID) {
      pending.splice(i, 1);
      return hook;
    }
  }
  return undefined;
}

function errorTypeLabel(error: DiagnosticError): string {
  switch (error.type) {
    case "hook-error":
      return error.hookEvent ? `${error.hookEvent} hook error` : "Hook error";
    case "mcp-disconnect":
      return "MCP server disconnect";
    case "old-binary":
      return "Old binary reference";
    case "duplicate-hook":
      return error.hookEvent ? `${error.hookEvent} duplicate hook` : "Duplicate hook";
  }
}

function compareErrors(a: DiagnosticError, b: DiagnosticError): number {
  const severity = (error: DiagnosticError) => (isWarning(error) ? 1 : 0);
  if (severity(a) !== severity(b)) return severity(a) - severity(b);
  if (b.count !== a.count) return b.count - a.count;
  return errorTypeLabel(a).localeCompare(errorTypeLabel(b));
}

function compareSessions(a: ScanSessionResult, b: ScanSessionResult): number {
  const aTime = a.lastTimestamp ? Date.parse(a.lastTimestamp) : a.mtimeMs;
  const bTime = b.lastTimestamp ? Date.parse(b.lastTimestamp) : b.mtimeMs;
  return bTime - aTime;
}

export async function scanSession(filePath: string): Promise<SessionDiagnostic> {
  const sessionId = basename(filePath, ".jsonl");
  const aggregate = new Map<string, DiagnosticError>();
  const pendingHooks: PendingHook[] = [];
  const duplicates = new Map<string, DuplicateGroup>();
  let sessionName: string | undefined;
  let lastTimestamp: string | undefined;
  let lineNumber = 0;

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      lineNumber++;
      if (!line.trim()) continue;

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;

      pendingHooks.splice(0, pendingHooks.length, ...prunePendingHooks(pendingHooks, lineNumber));

      const timestamp = getEntryTimestamp(entry);
      if (timestamp) lastTimestamp = timestamp;

      if (entry.type === "custom-title") {
        sessionName = getString(entry.customTitle) ?? sessionName;
      }

      const disconnect = getMcpDisconnect(entry);
      if (disconnect) {
        addAggregatedError(aggregate, {
          type: "mcp-disconnect",
          timestamp,
          details: disconnect,
        });
      }

      const hookError = getStructuredHookError(entry);
      if (hookError) {
        const matchedHook = matchPendingHook(pendingHooks, entry, lineNumber);
        if (matchedHook) {
          addAggregatedError(aggregate, {
            type: "hook-error",
            hookEvent: matchedHook.hookEvent,
            command: matchedHook.command,
            timestamp: matchedHook.timestamp ?? timestamp,
            details: hookError,
          });
        }
      }

      if (entry.type !== "progress" || !isRecord(entry.data) || entry.data.type !== "hook_progress") {
        continue;
      }

      const hookEvent = getString(entry.data.hookEvent);
      const command = getString(entry.data.command);
      if (!isRelevantHookCommand(command)) continue;

      if (isOldBinaryCommand(command)) {
        addAggregatedError(aggregate, {
          type: "old-binary",
          hookEvent,
          command,
          timestamp,
          details: command,
        });
      }

      const parentToolUseID = getToolUseID(entry);
      const duplicateKey = [parentToolUseID ?? "", hookEvent ?? "", command].join("\u001f");
      const duplicate = duplicates.get(duplicateKey);
      if (duplicate) {
        duplicate.count += 1;
      } else {
        duplicates.set(duplicateKey, {
          command,
          count: 1,
          hookEvent,
          timestamp,
        });
      }

      pendingHooks.push({
        command,
        hookEvent,
        lineNumber,
        parentToolUseID,
        timestamp,
      });
    }
  } finally {
    reader.close();
    stream.close();
  }

  for (const duplicate of duplicates.values()) {
    if (duplicate.count <= 1) continue;
    addAggregatedError(aggregate, {
      type: "duplicate-hook",
      hookEvent: duplicate.hookEvent,
      command: duplicate.command,
      timestamp: duplicate.timestamp,
      details: duplicate.command,
    }, duplicate.count);
  }

  return {
    sessionId,
    sessionName,
    filePath,
    lastTimestamp,
    errors: Array.from(aggregate.values()).sort(compareErrors),
  };
}

function getProjectDirs(options: DiagnoseOptions): string[] {
  const claudeProjectsDir = options._claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjectsDir)) return [];

  if (options.all) {
    return readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(claudeProjectsDir, entry.name));
  }

  const cwd = options.cwd ?? process.cwd();
  const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
  return existsSync(projectDir) ? [projectDir] : [];
}

export async function diagnose(options: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const days = options.days ?? 7;
  const cutoffMs = (options._nowMs ?? Date.now()) - days * 24 * 60 * 60 * 1000;
  const sessionFiles = getProjectDirs(options)
    .flatMap((projectDir) => findSessionFiles(projectDir))
    .map(({ path, mtime }) => ({ path, mtimeMs: mtime }))
    .filter((session) => session.mtimeMs >= cutoffMs);

  const sessions: ScanSessionResult[] = [];
  for (const { path, mtimeMs } of sessionFiles) {
    const session = await scanSession(path);
    sessions.push({
      ...session,
      mtimeMs,
    });
  }

  const sessionsWithIssues = sessions
    .filter((session) => session.errors.length > 0)
    .sort(compareSessions);

  const totalErrors = sessionsWithIssues.reduce(
    (total, session) => total + session.errors.filter((error) => !isWarning(error)).reduce((sum, error) => sum + error.count, 0),
    0
  );
  const totalWarnings = sessionsWithIssues.reduce(
    (total, session) => total + session.errors.filter(isWarning).reduce((sum, error) => sum + error.count, 0),
    0
  );

  const mostCommonCounts = new Map<string, number>();
  for (const session of sessionsWithIssues) {
    for (const error of session.errors) {
      if (isWarning(error)) continue;
      const label = errorTypeLabel(error);
      mostCommonCounts.set(label, (mostCommonCounts.get(label) ?? 0) + error.count);
    }
  }

  let mostCommon: DiagnoseResult["mostCommon"];
  for (const [type, count] of mostCommonCounts.entries()) {
    if (!mostCommon || count > mostCommon.count) {
      mostCommon = { type, count };
    }
  }

  return {
    sessionsScanned: sessionFiles.length,
    sessionsWithErrors: sessionsWithIssues.length,
    totalErrors,
    totalWarnings,
    sessions: sessionsWithIssues.map(({ mtimeMs: _mtimeMs, ...session }) => session),
    mostCommon,
  };
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function plural(count: number, singular: string, pluralForm = singular + "s"): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatErrorLine(error: DiagnosticError): string {
  switch (error.type) {
    case "hook-error":
      return `${error.hookEvent ?? "Hook"} hook error${error.count > 1 ? ` (${error.count}x)` : ""}`;
    case "mcp-disconnect":
      return `MCP server disconnect${error.count > 1 ? ` (${error.count}x)` : ""}`;
    case "old-binary":
      return `Hook uses old binary: ${error.command ?? "lossless-claude"}${error.count > 1 ? ` (${error.count}x)` : ""}`;
    case "duplicate-hook":
      return `Duplicate hook firing: ${error.hookEvent ?? "hook"}${error.command ? ` (${error.command})` : ""}${error.count > 1 ? ` (${error.count}x)` : ""}`;
  }
}

export function formatDiagnoseResult(
  result: DiagnoseResult,
  options: Pick<DiagnoseOptions, "days" | "verbose"> = {}
): string {
  const days = options.days ?? 7;
  const lines: string[] = [];
  lines.push(`  Scanning ${plural(result.sessionsScanned, "session")} (last ${plural(days, "day")})...`);
  lines.push("");

  if (result.sessions.length === 0) {
    lines.push("  No issues found.");
    lines.push("");
    lines.push("  Suggestion: Run `lcm doctor` to check current health");
    return lines.join("\n") + "\n";
  }

  for (const session of result.sessions) {
    const meta: string[] = [];
    if (session.sessionName) meta.push(session.sessionName);
    if (session.lastTimestamp) meta.push(session.lastTimestamp.slice(0, 10));
    lines.push(`  Session ${shortSessionId(session.sessionId)}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}:`);
    for (const error of session.errors) {
      const icon = isWarning(error) ? "⚠" : "✗";
      lines.push(`    ${icon} ${formatErrorLine(error)}`);
      if (options.verbose && error.details) {
        lines.push(`      ${error.details}`);
      }
    }
    lines.push("");
  }

  const totals = [`${plural(result.sessionsWithErrors, "session")} with issues`, `${plural(result.totalErrors, "total error")}`];
  if (result.totalWarnings > 0) totals.push(plural(result.totalWarnings, "warning"));
  lines.push(`  ${totals.join(", ")}`);
  if (result.mostCommon) {
    lines.push("");
    lines.push(`  Most common: ${result.mostCommon.type} (${result.mostCommon.count}x)`);
  }

  // Collect unique duplicate-hook events across all sessions for a specific hint
  const duplicateHookEvents = Array.from(
    new Set(
      result.sessions.flatMap((s) =>
        s.errors
          .filter((e) => e.type === "duplicate-hook" && e.hookEvent)
          .map((e) => e.hookEvent as string)
      )
    )
  );

  lines.push("");
  if (duplicateHookEvents.length > 0) {
    const settingsPath = `~/.claude/settings.json`;
    const eventList = duplicateHookEvents.map((e) => `\`${e}\``).join(", ");
    lines.push(`  Fix: Remove the duplicate ${eventList} hook ${duplicateHookEvents.length === 1 ? "entry" : "entries"} from \`${settingsPath}\``);
    lines.push(`       (hooks are owned by the plugin — run \`lcm install\` to clean up automatically)`);
  } else {
    lines.push("  Suggestion: Run `lcm doctor` to check current health");
  }
  return lines.join("\n") + "\n";
}
