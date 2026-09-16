import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  combineWithPivotQuery,
  extractQueryTerms,
  prepareFts5Query,
  shouldRetryWithLike,
  likePlanForPreparedQuery,
} from "../../src/store/fts5-query.js";
import { invalidateLanguagePacks } from "../../src/store/language-pack.js";

describe("extractQueryTerms", () => {
  it("drops nothing when no language is given", () => {
    expect(extractQueryTerms("how did we undo that broken release?")).toEqual([
      "how", "did", "we", "undo", "that", "broken", "release",
    ]);
  });

  it("drops the English pack's function words and keeps content words when 'en' is given", () => {
    expect(extractQueryTerms("how did we undo that broken release?", undefined, ["en"])).toEqual([
      "undo",
      "broken",
      "release",
    ]);
  });

  it("lowercases and splits on punctuation", () => {
    expect(extractQueryTerms("Why is CI red??", undefined, ["en"])).toEqual(["ci", "red"]);
  });

  it("dedupes repeated terms", () => {
    expect(extractQueryTerms("deploy deploy deploy")).toEqual(["deploy"]);
  });

  it("keeps hyphenated-word halves as separate terms", () => {
    expect(extractQueryTerms("merge-train stuck")).toEqual(["merge", "train", "stuck"]);
  });

  it("keeps raw words when every word is a stopword", () => {
    expect(extractQueryTerms("how do we do it", undefined, ["en"])).toEqual(["how", "do", "we", "it"]);
  });

  it("returns an empty list for punctuation-only input", () => {
    expect(extractQueryTerms("?!...")).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(extractQueryTerms("")).toEqual([]);
  });

  it("keeps accented words whole, like the unicode61 tokenizer", () => {
    // Note: no language is given, so nothing is dropped — this exercises
    // tokenization only, independent of any pack.
    expect(extractQueryTerms("¿cómo revertimos el despliegue fallido?")).toEqual([
      "cómo",
      "revertimos",
      "el",
      "despliegue",
      "fallido",
    ]);
  });
});

describe("prepareFts5Query", () => {
  it("builds quoted AND and OR expressions", () => {
    const raw = "how did we undo that broken release?";
    const prepared = prepareFts5Query(raw, extractQueryTerms(raw, undefined, ["en"]));
    expect(prepared).not.toBeNull();
    expect(prepared!.terms).toEqual(["undo", "broken", "release"]);
    expect(prepared!.and).toBe('"undo" "broken" "release"');
    expect(prepared!.or).toBe('"undo" OR "broken" OR "release"');
  });

  it("single term: AND and OR are identical", () => {
    const prepared = prepareFts5Query("worktrees");
    expect(prepared!.and).toBe('"worktrees"');
    expect(prepared!.or).toBe('"worktrees"');
  });

  it("neutralizes FTS5 operators in terms", () => {
    const prepared = prepareFts5Query('lcm_expand OR crash "quoted" agent:foo lcm*');
    for (const expr of [prepared!.and, prepared!.or]) {
      expect(expr).not.toContain("agent:foo");
    }
    expect(prepared!.and).toContain('"lcm"');
    expect(prepared!.and).toContain('"quoted"');
  });

  it("returns null when there are no usable terms", () => {
    expect(prepareFts5Query("?!")).toBeNull();
    expect(prepareFts5Query("")).toBeNull();
  });
});

describe("shouldRetryWithLike", () => {
  it("retries multi-term questions, not single keywords", () => {
    expect(shouldRetryWithLike(prepareFts5Query("how did we undo the outage?")!)).toBe(true);
    expect(shouldRetryWithLike(prepareFts5Query("rollback")!)).toBe(false);
  });
});

describe("likePlanForPreparedQuery", () => {
  it("builds LIKE clauses for the content terms", () => {
    const raw = "how did we undo that broken release?";
    const prepared = prepareFts5Query(raw, extractQueryTerms(raw, undefined, ["en"]))!;
    const plan = likePlanForPreparedQuery("content", prepared);
    expect(plan.terms).toEqual(["undo", "broken", "release"]);
    expect(plan.where).toEqual([
      "LOWER(content) LIKE ? ESCAPE '\\'",
      "LOWER(content) LIKE ? ESCAPE '\\'",
      "LOWER(content) LIKE ? ESCAPE '\\'",
    ]);
    expect(plan.args).toEqual(["%undo%", "%broken%", "%release%"]);
  });
});

describe("combineWithPivotQuery", () => {
  const packDir = mkdtempSync(join(tmpdir(), "lcm-pivot-pack-"));
  const packWords = ["o", "e", "os", "as", "um", "de", "do", "da", "em", "na", "se", "ao",
    "que", "como", "para", "foi", "não", "por", "isso", "com", "uma", "quando", "onde", "qual",
    "desse", "nesse", "pelo", "pela", "assim", "então", "porque", "sobre", "entre", "desde", "ainda", "também",
    "aquele", "aquilo", "cada", "todos", "muito", "pouco", "sempre", "nunca", "talvez"];

  beforeEach(() => {
    process.env.LCM_LANGUAGES_DIR = packDir;
    writeFileSync(join(packDir, "pt-BR.json"), JSON.stringify({ version: 1, tag: "pt-BR", stopwords: packWords, generatedAt: "" }));
    invalidateLanguagePacks();
  });
  afterEach(() => {
    delete process.env.LCM_LANGUAGES_DIR;
    invalidateLanguagePacks();
  });

  it("leaves the query untouched when no pivot query is supplied", () => {
    expect(combineWithPivotQuery("como revertemos o release quebrado?")).toBe("como revertemos o release quebrado?");
    expect(combineWithPivotQuery("como foi isso?", undefined, "   ")).toBe("como foi isso?");
  });

  it("leaves the query untouched when the pivot query adds no term", () => {
    expect(combineWithPivotQuery(
      "broken release", undefined, "the broken release", { authorLanguage: "en", pivotLanguage: "en" },
    )).toBe("broken release");
  });

  it("adds the pivot terms and drops each side's own function words", () => {
    const combined = combineWithPivotQuery(
      "como foi que revertemos o release quebrado?",
      undefined,
      "how did we roll back the broken release?",
      { authorLanguage: "pt-BR", pivotLanguage: "en" },
    );
    expect(combined.split(" ")).toEqual(["revertemos", "release", "quebrado", "roll", "back", "broken"]);
  });
});
