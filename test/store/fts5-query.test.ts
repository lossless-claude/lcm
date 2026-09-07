import { describe, it, expect } from "vitest";
import {
  extractQueryTerms,
  prepareFts5Query,
  shouldRetryWithLike,
  likePlanForPreparedQuery,
} from "../../src/store/fts5-query.js";

describe("extractQueryTerms", () => {
  it("drops stopwords and keeps content words", () => {
    expect(extractQueryTerms("how did we undo that broken release?")).toEqual([
      "undo",
      "broken",
      "release",
    ]);
  });

  it("lowercases and splits on punctuation", () => {
    expect(extractQueryTerms("Why is CI red??")).toEqual(["ci", "red"]);
  });

  it("dedupes repeated terms", () => {
    expect(extractQueryTerms("deploy deploy deploy")).toEqual(["deploy"]);
  });

  it("keeps hyphenated-word halves as separate terms", () => {
    expect(extractQueryTerms("merge-train stuck")).toEqual(["merge", "train", "stuck"]);
  });

  it("keeps raw words when every word is a stopword", () => {
    expect(extractQueryTerms("how do we do it")).toEqual(["how", "do", "we", "it"]);
  });

  it("returns an empty list for punctuation-only input", () => {
    expect(extractQueryTerms("?!...")).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(extractQueryTerms("")).toEqual([]);
  });

  it("keeps accented words whole, like the unicode61 tokenizer", () => {
    // Note: the stopword list is English-only; "el" survives as a term and
    // is handled by the OR fallback like any other non-matching term.
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
    const prepared = prepareFts5Query("how did we undo that broken release?");
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
    const prepared = prepareFts5Query("how did we undo that broken release?")!;
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
