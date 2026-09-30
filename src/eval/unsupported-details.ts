export type UnsupportedDetail = {
  kind: "number" | "path" | "identifier" | "quoted";
  text: string;
  start: number;
  end: number;
};

/** Deterministic hint, not proof: exact details absent from this call's source. */
export function findUnsupportedDetails(source: string, summary: string): UnsupportedDetail[] {
  const patterns: Array<[UnsupportedDetail["kind"], RegExp]> = [
    ["quoted", /"[^"\n]+"|(?<!\w)'[^'\n]+'(?!\w)|`[^`\n]+`|“[^”\n]+”/g],
    ["path", /(?<![\w.-])(?:[A-Za-z]:\\|(?:\.{1,2}|~)?\/)[\w.\-/\\]+|\b[\w.-]+(?:\/[\w.-]+)+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|yaml|yml|md|py|go|rs|sqlite|sql|txt)\b/g],
    ["identifier", /(?<![\w-])--[a-zA-Z][\w-]*|\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\b|\b[a-zA-Z_$][\w$]*(?=\()|\b(?:[a-zA-Z_$][\w$]*[_$][\w$]+|[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[A-Z]{2,}[\w$]*)\b/g],
    ["number", /(?<![\w$])(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)(?![\w$])/g],
  ];
  const occupied: Array<{ start: number; end: number }> = [];
  const unsupported: UnsupportedDetail[] = [];
  for (const [kind, pattern] of patterns) {
    for (const match of summary.matchAll(pattern)) {
      if (kind === "path" && match[0].includes("/")
        && match[0].split("/").every((segment) => /^[A-Za-z]+(?:-[A-Za-z]+)*$/.test(segment))) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some((span) => start < span.end && end > span.start)) continue;
      occupied.push({ start, end });
      const text = match[0];
      const value = kind === "quoted" ? text.slice(1, -1) : text;
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const present = kind === "quoted"
        ? source.includes(value)
        : new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(source);
      if (!present) unsupported.push({ kind, text, start, end });
    }
  }
  return unsupported.sort((a, b) => a.start - b.start);
}
