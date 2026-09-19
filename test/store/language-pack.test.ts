import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLanguagePack,
  hasLanguagePack,
  invalidateLanguagePacks,
  languagePackPath,
  loadLanguagePacks,
  packStopwordsFor,
  parseLanguagePackReply,
} from "../../src/store/language-pack.js";
import {
  combineWithPivotQuery,
  combinedQueryTerms,
  extractQueryTerms,
  prepareFts5Query,
} from "../../src/store/fts5-query.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

const PT_WORDS = ["a", "o", "que", "como", "para", "foi", "não", "você", "isso", "de", "do", "da", "em", "um", "uma", "os", "as", "com", "por", "se", "mas", "ou", "já", "ainda", "também", "está", "são", "tem", "era", "sobre", "onde", "quando", "qual"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcm-lang-"));
  process.env.LCM_LANGUAGES_DIR = dir;
  invalidateLanguagePacks();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  invalidateLanguagePacks();
});

function writePack(tag: string, stopwords: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tag}.json`), JSON.stringify({ version: 1, tag, stopwords, generatedAt: "2026-09-08T00:00:00Z" }));
  invalidateLanguagePacks();
}

describe("query terms with language packs", () => {
  it("prefers an explicit storage root over the compatibility environment override", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-lang-explicit-"));
    try {
      const paths = createLcmPaths(root);
      const languagesDir = join(root, "languages");
      mkdirSync(languagesDir, { recursive: true });
      writeFileSync(join(languagesDir, "pt-BR.json"), JSON.stringify({ version: 1, tag: "pt-BR", stopwords: PT_WORDS, generatedAt: "2026-09-08T00:00:00Z" }));
      invalidateLanguagePacks();
      expect(languagePackPath(paths, "pt-BR")).toBe(join(languagesDir, "pt-BR.json"));
      expect(extractQueryTerms("como foi o deploy que quebrou a busca?", paths, ["pt-BR"])).toEqual(["deploy", "quebrou", "busca"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads packs from the caller's storage root without an environment override", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-lang-root-"));
    delete process.env.LCM_LANGUAGES_DIR;
    try {
      const paths = createLcmPaths(root);
      const languagesDir = join(root, "languages");
      mkdirSync(languagesDir, { recursive: true });
      writeFileSync(join(languagesDir, "pt-BR.json"), JSON.stringify({ version: 1, tag: "pt-BR", stopwords: PT_WORDS, generatedAt: "2026-09-08T00:00:00Z" }));
      invalidateLanguagePacks();
      expect(extractQueryTerms("como foi o deploy que quebrou a busca?", paths, ["pt-BR"])).toEqual(["deploy", "quebrou", "busca"]);
    } finally {
      process.env.LCM_LANGUAGES_DIR = dir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips a pack's function words from a question in that language", () => {
    writePack("pt-BR", PT_WORDS);
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?", undefined, ["pt-BR"])).toEqual(["deploy", "quebrou", "busca"]);
  });

  it("matches a pack on the primary subtag, either way round", () => {
    writePack("pt-BR", PT_WORDS);
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?", undefined, ["pt"])).toEqual(["deploy", "quebrou", "busca"]);
    writePack("es", ["el", "la", "de", "que"]);
    expect(extractQueryTerms("que hizo el deploy", undefined, ["es-MX"])).toEqual(["hizo", "deploy"]);
  });

  it("changes nothing when no pack is installed", () => {
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?", undefined, ["pt-BR"])).toEqual(["como", "foi", "o", "deploy", "que", "quebrou", "a", "busca"]);
  });

  it("applies no pack the configured languages do not name, whatever the query's words", () => {
    writePack("pt-BR", PT_WORDS);
    const question = "como foi o deploy que quebrou a busca?";
    expect(extractQueryTerms(question)).toEqual(["como", "foi", "o", "deploy", "que", "quebrou", "a", "busca"]);
    // Tagged "en", only the query's own English-pack word ("a") is dropped — the
    // pt-BR pack was never named, so its words survive whatever the query means.
    expect(extractQueryTerms(question, undefined, ["en"])).toEqual(["como", "foi", "o", "deploy", "que", "quebrou", "busca"]);
    // "era" is a pt-BR function word and an English noun; an English project keeps it.
    expect(extractQueryTerms("which era introduced the daemon?", undefined, ["en"])).toEqual(["era", "introduced", "daemon"]);
  });

  it("still keeps the raw words when everything is a function word", () => {
    writePack("pt-BR", PT_WORDS);
    expect(extractQueryTerms("o que foi isso?", undefined, ["pt-BR"])).toEqual(["o", "que", "foi", "isso"]);
  });

  it("skips a malformed pack and keeps the others", () => {
    writePack("pt-BR", PT_WORDS);
    writeFileSync(join(dir, "de.json"), "{ not json");
    writeFileSync(join(dir, "fr.json"), JSON.stringify({ version: 2, tag: "fr", stopwords: ["le"] }));
    invalidateLanguagePacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...loadLanguagePacks().keys()]).toEqual(["pt-BR"]);
    expect(packStopwordsFor(["pt-BR"]).has("que")).toBe(true);
    expect(packStopwordsFor(["fr"]).size).toBe(0);
    warn.mockRestore();
  });

  it("serves the built-in English pack with no file on disk", () => {
    expect(extractQueryTerms("how did we undo that broken release?", undefined, ["en"])).toEqual([
      "undo", "broken", "release",
    ]);
    expect(hasLanguagePack("en")).toBe(true);
  });

  it("lets a disk pack for 'en' replace the built-in rather than add to it", () => {
    writePack("en", ["release"]);
    // The built-in's "how"/"did"/"we" survive: only the disk file's own words are dropped.
    expect(extractQueryTerms("how did we undo that broken release?", undefined, ["en"])).toEqual([
      "how", "did", "we", "undo", "that", "broken",
    ]);
  });
});

describe("hasLanguagePack", () => {
  it("is true for a built-in tag with no file, and for a tag with a file", () => {
    expect(hasLanguagePack("en")).toBe(true);
    expect(hasLanguagePack("pt-BR")).toBe(false);
    writePack("pt-BR", PT_WORDS);
    expect(hasLanguagePack("pt-BR")).toBe(true);
  });
});

describe("ensureLanguagePack and the built-in English pack", () => {
  it("resolves 'en' as already satisfied without calling the model or writing a file", async () => {
    const summarize = vi.fn();
    expect(await ensureLanguagePack("en", summarize)).toBe("exists");
    expect(summarize).not.toHaveBeenCalled();
    expect(existsSync(languagePackPath("en"))).toBe(false);
  });
});

describe("parseLanguagePackReply", () => {
  it("reads a bare JSON array", () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
    expect(parseLanguagePackReply(JSON.stringify(words))).toEqual(words);
  });

  it("reads an array wrapped in a code fence or prose, lowercased and deduped", () => {
    const words = Array.from({ length: 40 }, (_, i) => `W${i}`);
    const reply = "Here you go:\n```json\n" + JSON.stringify([...words, "w1", " w2 "]) + "\n```\nDone.";
    expect(parseLanguagePackReply(reply)).toEqual(words.map((w) => w.toLowerCase()));
  });

  it("drops phrases and non-strings", () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
    expect(parseLanguagePackReply(JSON.stringify([...words, "not a word", 42, ""]))).toEqual(words);
  });

  it("refuses an undersized or unparseable reply", () => {
    expect(parseLanguagePackReply(JSON.stringify(["a", "o", "de"]))).toBeNull();
    expect(parseLanguagePackReply("I cannot help with that.")).toBeNull();
    expect(parseLanguagePackReply("[oops")).toBeNull();
  });
});

describe("ensureLanguagePack", () => {
  const reply = JSON.stringify(PT_WORDS.concat(Array.from({ length: 20 }, (_, i) => `extra${i}`)));

  it("generates a pack once and reuses it afterwards", async () => {
    const summarize = vi.fn().mockResolvedValue(reply);
    expect(await ensureLanguagePack("pt-BR", summarize, "openai:test")).toBe("generated");
    expect(await ensureLanguagePack("pt-BR", summarize, "openai:test")).toBe("exists");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0]).toContain('"pt-BR"');
    const pack = JSON.parse(readFileSync(languagePackPath("pt-BR"), "utf-8"));
    expect(pack).toMatchObject({ version: 1, tag: "pt-BR", generatedBy: "openai:test" });
    expect(pack.stopwords).toContain("que");
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?", undefined, ["pt-BR"])).toEqual(["deploy", "quebrou", "busca"]);
  });

  it("shares one generation between concurrent callers", async () => {
    const summarize = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(reply), 20)));
    const results = await Promise.all([ensureLanguagePack("pt-BR", summarize), ensureLanguagePack("pt-BR", summarize)]);
    expect(results).toEqual(["generated", "generated"]);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("writes nothing and reports failure when the model gives no usable list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summarize = vi.fn().mockResolvedValue("Sorry, no.");
    expect(await ensureLanguagePack("pt-BR", summarize)).toBe("failed");
    expect(existsSync(languagePackPath("pt-BR"))).toBe(false);
    const thrower = vi.fn().mockRejectedValue(new Error("provider down"));
    expect(await ensureLanguagePack("pt-BR", thrower)).toBe("failed");
    expect(await ensureLanguagePack("../etc", summarize)).toBe("failed");
    warn.mockRestore();
  });
});

describe("a pivot union survives the layers below it", () => {
  // Each side is tokenised under its own language. A pack that lists a content word from
  // each side — and would once have activated on the mixture — is never consulted, because
  // no configured language names it.
  const SPLIT = ["compactação", "keep"];
  const languages = { authorLanguage: "pt-BR", pivotLanguage: "en" };

  const query = "como a compactação decide o que manter";
  const pivot = "how does compaction decide what to keep";

  it("tokenises each side under its own language and ignores packs neither names", () => {
    writePack("pt", PT_WORDS);
    writePack("xx", SPLIT);

    const union = combinedQueryTerms(query, undefined, pivot, languages)!;
    expect(union).toEqual(["compactação", "decide", "manter", "compaction", "keep"]);
    // With no author language configured, the pt-BR side loses no function words at all.
    expect(combinedQueryTerms(query, undefined, pivot, { pivotLanguage: "en" })).toEqual(
      ["como", "a", "compactação", "decide", "o", "que", "manter", "compaction", "keep"],
    );
  });

  it("prepareFts5Query keeps the union when it is handed the terms", () => {
    writePack("pt", PT_WORDS);
    // "era" is a pivot-side content word and a pt-BR function word: re-tokenising the
    // union under the author's language would drop it.
    const query = "qual versão introduziu o daemon";
    const pivot = "which era introduced the daemon";

    const combined = combineWithPivotQuery(query, undefined, pivot, languages);
    const union = combinedQueryTerms(query, undefined, pivot, languages)!;
    expect(union).toContain("era");

    expect(prepareFts5Query(combined, union)!.terms).toEqual(union);
    // Without them, a layer below that tokenises under the author's language searches a smaller set.
    expect(extractQueryTerms(combined, undefined, ["pt-BR"])).not.toContain("era");
  });
});
