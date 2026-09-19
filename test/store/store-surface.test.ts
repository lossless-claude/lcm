import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The tables Episodic and Promoted memory keep are reached through their
 * stores (src/store/, src/db/promoted.ts). A route, the importer or the
 * capture module that prepares its own statement against one of them is a
 * second definition of what the store already decides.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const STORE_TABLES = ["conversations", "messages", "context_items", "summaries", "promoted"];
const GUARDED_FILES = [
  ...readdirSync(join(ROOT, "src", "daemon", "routes")).filter((f) => f.endsWith(".ts")).map((f) => join("src", "daemon", "routes", f)),
  join("src", "import.ts"),
  join("src", "capture.ts"),
];

type Statement = { file: string; line: number; sql: string | null };

/** The string literal starting at `at`, or null when what starts there is not one. */
function literalAt(text: string, at: number): string | null {
  const quote = text[at];
  if (quote !== "`" && quote !== '"' && quote !== "'") return null;
  let end = at + 1;
  while (end < text.length && text[end] !== quote) {
    end += text[end] === "\\" ? 2 : 1;
  }
  return text.slice(at + 1, end);
}

/** Every `.prepare(` / `.exec(` call with its literal SQL, or `sql: null` when the argument is not a literal. */
function statementsIn(file: string): Statement[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const found: Statement[] = [];
  const call = /\.(?:prepare|exec)\(\s*/g;
  for (let match = call.exec(text); match; match = call.exec(text)) {
    const line = text.slice(0, match.index).split("\n").length;
    found.push({ file, line, sql: literalAt(text, match.index + match[0].length) });
  }
  return found;
}

const TABLE_REFERENCE = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:${STORE_TABLES.join("|")})\\b`, "i");

describe("store surface", () => {
  it("no route, the importer or capture prepares its own statement against a store's table", () => {
    const offenders = GUARDED_FILES.flatMap(statementsIn)
      .filter((s) => s.sql === null || TABLE_REFERENCE.test(s.sql))
      .map((s) => `${s.file}:${s.line}${s.sql === null ? " (non-literal statement)" : ""}`);
    expect(offenders).toEqual([]);
  });
});
