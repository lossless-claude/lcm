import { readFileSync } from "node:fs";

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  is_error?: boolean;
  content?: string | ContentBlock[];
  /** `tool_use` input — only read when `name === "Skill"`, for the skill's name and args. */
  input?: { skill?: unknown; args?: unknown };
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

/**
 * A skill invocation or slash command, recorded as structure rather than as a
 * substring of a message body. Never the expanded skill prompt or command
 * output — that stays in the message's own content.
 */
export type MessagePart =
  | { type: "skill"; name: string; args: string | null }
  | { type: "command"; name: string; args: string | null };

export interface ParsedMessage {
  role: string;
  content: string;
  tokenCount: number;
  parts?: MessagePart[];
}

function extractText(content: string | ContentBlock[] | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => {
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "tool_result") return extractText(b.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Marks a tool result the tool itself reported as failed. */
const TOOL_ERROR_MARKER = "[tool error]";

function blocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}

const hasProse = (blocks: ContentBlock[]): boolean =>
  blocks.some(b => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");

/**
 * The role to store an entry under.
 *
 * The transcript's own `role` says who the turn belongs to, not who produced
 * the text: a tool result comes back as a `user` turn, and ingesting it that
 * way tells a later reader the user said it. So the blocks decide.
 *
 * Prose wins. An entry that mixes human text with a tool result is human —
 * measured, that combination occurs once in 8749 entries, and calling it a
 * tool log would lose a real user message to save almost nothing.
 */
function roleOf(entryRole: string, content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return entryRole;
  const blocks = blocksOf(content);
  if (blocks.length === 0 || hasProse(blocks)) return entryRole;
  if (blocks.some(b => b.type === "tool_result" || b.type === "tool_use")) return "tool";
  return entryRole;
}

/**
 * What to store for an entry that holds no prose.
 *
 * A `tool_use` carries the call, whose input can be an entire file; only the
 * name is kept, so the record says a tool ran without dragging its argument
 * into memory. A `tool_result` carries the output, which is worth keeping, and
 * its failure flag is recorded as a searchable marker.
 */
function toolContent(blocks: ContentBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool_use") {
      lines.push(typeof block.name === "string" && block.name ? block.name : "tool_use");
      continue;
    }
    if (block.type !== "tool_result") continue;
    const output = extractText(block.content);
    lines.push(block.is_error ? `${TOOL_ERROR_MARKER}\n${output}` : output);
  }
  return lines.filter(line => line.trim() !== "").join("\n");
}

/**
 * A `Skill` tool_use already carries its name in a structured field — the
 * expansion that follows is what arrives as text, not the invocation itself.
 */
function extractSkillParts(blocks: ContentBlock[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_use" || block.name !== "Skill") continue;
    const skill = typeof block.input?.skill === "string" ? block.input.skill.trim() : "";
    if (!skill) continue;
    const args = typeof block.input?.args === "string" ? block.input.args.trim() : "";
    parts.push({ type: "skill", name: skill, args: args || null });
  }
  return parts;
}

const COMMAND_NAME_RE = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/;

/** A slash command block quoted inside a code fence is documentation, not an invocation. */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

export function extractCommandParts(text: string): MessagePart[] {
  const searchable = stripCodeFences(text);
  const name = searchable.match(COMMAND_NAME_RE)?.[1]?.trim();
  if (!name) return [];
  const args = searchable.match(COMMAND_ARGS_RE)?.[1]?.trim() ?? "";
  return [{ type: "command", name, args: args || null }];
}

export function parseTranscript(transcriptPath: string): ParsedMessage[] {
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
    try {
      const obj: TranscriptLine = JSON.parse(trimmed);
      const entryRole = obj.message?.role;
      if (!entryRole || !["user", "assistant", "system"].includes(entryRole)) continue;
      // One transcript entry stays one message, whatever it holds. Splitting a
      // turn into several would break the sequence every reader depends on.
      const blocks = blocksOf(obj.message?.content);
      const role = roleOf(entryRole, obj.message?.content);
      const content = role === "tool" ? toolContent(blocks) : extractText(obj.message?.content);
      if (!content.trim()) continue;
      const parts = [...extractSkillParts(blocks), ...extractCommandParts(content)];
      messages.push({ role, content, tokenCount: estimateTokens(content), ...(parts.length ? { parts } : {}) });
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}
