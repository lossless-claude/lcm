import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

const METADATA_BYTES = 4096;
const SCALAR = /^(?:"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;

/** Read only leading envelopes; payload fields are never decoded to infer ownership. */
export function recordedTranscriptCwd(path: string): string | undefined {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink()) return undefined;
  const fd = openSync(path, "r"), buffer = Buffer.alloc(METADATA_BYTES);
  try {
    const prefix = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    for (const line of prefix.split("\n")) {
      const cwd = envelopeCwd(line);
      if (cwd) return cwd;
    }
    return undefined;
  }
  finally { closeSync(fd); }
}
function envelopeCwd(prefix: string): string | undefined {
  let remainder = prefix.trimStart();
  if (!remainder.startsWith("{")) return undefined;
  remainder = remainder.slice(1).trimStart();
  while (remainder.length) {
    const field = envelopeField(remainder);
    if (!field) return undefined;
    if (field.key === "cwd") return typeof field.value === "string" && isAbsolute(field.value) ? field.value : undefined;
    remainder = field.remainder;
    if (!remainder.startsWith(",")) return undefined;
    remainder = remainder.slice(1).trimStart();
  }
  return undefined;
}
function envelopeField(remainder: string): { key: string; value: unknown; remainder: string } | undefined {
  const key = scalar(remainder);
  if (!key || typeof key.value !== "string") return undefined;
  remainder = remainder.slice(key.length).trimStart();
  if (!remainder.startsWith(":")) return undefined;
  if (["message", "content", "attachment", "data"].includes(key.value)) return undefined;
  remainder = remainder.slice(1).trimStart();
  const value = scalar(remainder);
  if (!value) return undefined;
  return { key: key.value, value: value.value, remainder: remainder.slice(value.length).trimStart() };
}
function scalar(text: string): { value: unknown; length: number } | undefined {
  const match = SCALAR.exec(text);
  if (!match) return undefined;
  return { value: JSON.parse(match[0]), length: match[0].length };
}
