import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLanguagePack,
  invalidateLanguagePacks,
  languagePackPath,
  loadLanguagePacks,
  packStopwordsFor,
  parseLanguagePackReply,
} from "../../src/store/language-pack.js";
import { extractQueryTerms } from "../../src/store/fts5-query.js";

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
  it("strips a pack's function words from a question in that language", () => {
    writePack("pt-BR", PT_WORDS);
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?")).toEqual(["deploy", "quebrou", "busca"]);
  });

  it("changes nothing when no pack is installed", () => {
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?")).toEqual(["como", "foi", "o", "deploy", "que", "quebrou", "busca"]);
  });

  it("ignores a single accidental hit in another language", () => {
    writePack("pt-BR", PT_WORDS);
    // "era" is a pt-BR function word and an English noun; one hit does not select the pack.
    expect(extractQueryTerms("which era introduced the daemon?")).toEqual(["era", "introduced", "daemon"]);
  });

  it("still keeps the raw words when everything is a function word", () => {
    writePack("pt-BR", PT_WORDS);
    expect(extractQueryTerms("o que foi isso?")).toEqual(["o", "que", "foi", "isso"]);
  });

  it("skips a malformed pack and keeps the others", () => {
    writePack("pt-BR", PT_WORDS);
    writeFileSync(join(dir, "de.json"), "{ not json");
    writeFileSync(join(dir, "fr.json"), JSON.stringify({ version: 2, tag: "fr", stopwords: ["le"] }));
    invalidateLanguagePacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...loadLanguagePacks().keys()]).toEqual(["pt-BR"]);
    expect(packStopwordsFor(["como", "foi"]).has("que")).toBe(true);
    warn.mockRestore();
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
    expect(extractQueryTerms("como foi o deploy que quebrou a busca?")).toEqual(["deploy", "quebrou", "busca"]);
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
