import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { createSummarizer, resolveSummarizerLanguage } from "../../src/daemon/summarizer.js";
import { loadDaemonConfig, type DaemonConfig } from "../../src/daemon/config.js";
import { resetProjectLanguageState, scheduleProjectLanguageDetection } from "../../src/daemon/project-language.js";
import { invalidateLanguagePacks, languagePackPath } from "../../src/store/language-pack.js";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";

let dir: string;
let paths: LcmPaths;
vi.mock("../../src/daemon/project.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/daemon/project.js")>(),
  projectMetaPath: (cwd: string) => join(cwd, "meta.json"),
}));
vi.mock("../../src/daemon/summarizer.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/daemon/summarizer.js")>(),
  createSummarizer: vi.fn(),
}));

/**
 * A real DaemonConfig built from the defaults, with no config file and an empty
 * environment: a change to the config shape breaks these tests instead of
 * hiding behind a cast, and no developer's own env var can steer them.
 */
function testConfig(llm: Partial<DaemonConfig["llm"]> = {}, search: Partial<DaemonConfig["search"]> = {}): DaemonConfig {
  return loadDaemonConfig(
    join(tmpdir(), "lcm-no-such-config.json"),
    { llm: { provider: "openai", model: "test-model", baseURL: "http://local.test", apiKey: "k", ...llm }, search },
    {},
  );
}
const PACK_REPLY = JSON.stringify(Array.from({ length: 40 }, (_, i) => `p${i}`).concat(["que", "como", "para"]));

async function seededDb(turns: number): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  const store = new ConversationStore(db);
  for (let s = 0; s < turns; s++) {
    const conv = await store.getOrCreateConversation(`session-${s}`);
    await store.createMessagesBulk([{
      conversationId: conv.conversationId,
      seq: 0,
      role: "user",
      content: `Bora revisar o daemon de memória antes do release desta semana, sessão ${s}?`,
      tokenCount: 20,
    }]);
  }
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcm-project-lang-"));
  paths = createLcmPaths(dir);
  process.env.LCM_LANGUAGES_DIR = join(dir, "languages");
  invalidateLanguagePacks();
  resetProjectLanguageState();
  vi.mocked(createSummarizer).mockReset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  invalidateLanguagePacks();
});

describe("scheduleProjectLanguageDetection", () => {
  it("returns the existing detection promise to concurrent callers", async () => {
    let finishDetection: ((language: string) => void) | undefined;
    const summarize = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishDetection = resolve; }))
      .mockResolvedValueOnce(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    const db = await seededDb(25);

    const detection = scheduleProjectLanguageDetection(dir, db, testConfig(), paths);
    const waiter = scheduleProjectLanguageDetection(dir, db, testConfig(), paths);
    expect(waiter).toBe(detection);
    expect(existsSync(join(dir, "meta.json"))).toBe(false);

    await vi.waitFor(() => expect(finishDetection).toBeTypeOf("function"));
    finishDetection?.("pt-BR");
    await Promise.all([detection, waiter]);
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")).language).toBe("pt-BR");
    expect(createSummarizer).toHaveBeenCalledOnce();
  });

  it("records the language in meta.json and generates the pack, once", async () => {
    const summarize = vi.fn().mockResolvedValueOnce("pt-BR").mockResolvedValueOnce(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    const db = await seededDb(25);
    await scheduleProjectLanguageDetection(dir, db, testConfig(), paths);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.language).toBe("pt-BR");
    await vi.waitFor(() => expect(existsSync(languagePackPath("pt-BR"))).toBe(true));
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0][0]).toContain("1. Bora revisar");
    await scheduleProjectLanguageDetection(dir, db, testConfig(), paths);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("generates the pivot language's pack too when it is neither English nor the author's", async () => {
    const summarize = vi.fn().mockResolvedValueOnce("pt-BR").mockResolvedValue(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig({}, { pivotLanguage: "es" }), paths);
    await vi.waitFor(() => expect(existsSync(languagePackPath("es"))).toBe(true));
    await vi.waitFor(() => expect(existsSync(languagePackPath("pt-BR"))).toBe(true));
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("generates no pivot pack for English or for the author's own language", async () => {
    const summarize = vi.fn().mockResolvedValueOnce("pt-BR").mockResolvedValue(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig({}, { pivotLanguage: "pt" }), paths);
    await vi.waitFor(() => expect(existsSync(languagePackPath("pt-BR"))).toBe(true));
    expect(existsSync(languagePackPath("pt"))).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("never asks for a provider to reconcile a default 'en' pivot: the built-in pack already satisfies it", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: dir, language: "pt-BR" }));
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig(), paths);
    expect(createSummarizer).not.toHaveBeenCalled();
    expect(existsSync(languagePackPath("en"))).toBe(false);
  });

  it("uses the request client to resolve an automatic provider", async () => {
    const summarize = vi.fn().mockResolvedValueOnce("pt-BR").mockResolvedValueOnce(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);

    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig({ provider: "auto" }), paths, "codex");

    expect(createSummarizer).toHaveBeenCalledWith("codex-process", expect.anything());
  });

  it("does nothing below the turn threshold, under a mock summarizer, or with a disabled provider", async () => {
    const summarize = vi.fn().mockResolvedValue("pt-BR");
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(5), testConfig(), paths);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), { ...testConfig(), summarizer: { mock: true } }, paths);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig({ provider: "disabled" }), paths);
    expect(summarize).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "meta.json"))).toBe(false);
  });

  it("keeps an existing language and never re-detects it", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: dir, language: "de" }));
    const summarize = vi.fn().mockResolvedValue("pt-BR");
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig(), paths);
    expect(summarize).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")).language).toBe("de");
  });

  it("ensures the pivot pack for an already-detected project without re-detecting", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: dir, language: "pt-BR" }));
    const summarize = vi.fn().mockResolvedValue(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig({}, { pivotLanguage: "es" }), paths);
    await vi.waitFor(() => expect(existsSync(languagePackPath("es"))).toBe(true));
    expect(summarize).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")).language).toBe("pt-BR");
  });

  it("stops retrying a pivot pack that fails to generate without throwing", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: dir, language: "pt-BR" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // ensureLanguagePack resolves "failed" rather than throwing when the model's
    // reply cannot be parsed as a stopword list — this must be caught the same
    // way a thrown error is.
    const summarize = vi.fn().mockResolvedValue("not a stopword list");
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    const db = await seededDb(25);

    await scheduleProjectLanguageDetection(dir, db, testConfig({}, { pivotLanguage: "es" }), paths);
    expect(summarize).toHaveBeenCalledTimes(1);

    await scheduleProjectLanguageDetection(dir, db, testConfig({}, { pivotLanguage: "es" }), paths);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(existsSync(languagePackPath("es"))).toBe(false);
    warn.mockRestore();
  });

  it("warns once and stops retrying when the provider fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summarize = vi.fn().mockRejectedValue(new Error("API key is invalid"));
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    const db = await seededDb(25);
    await scheduleProjectLanguageDetection(dir, db, testConfig(), paths);
    await scheduleProjectLanguageDetection(dir, db, testConfig(), paths);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("API key is invalid");
    expect(existsSync(join(dir, "meta.json"))).toBe(false);
    warn.mockRestore();
  });
});

describe("resolveSummarizerLanguage", () => {
  it("prefers explicit configuration over the recorded project language", () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: dir, language: "pt-BR" }));

    expect(resolveSummarizerLanguage(testConfig(), dir, paths)).toBe("pt-BR");
    expect(resolveSummarizerLanguage({
      ...testConfig(),
      summarizer: { mock: false, language: "en" },
    }, dir, paths)).toBe("en");
  });

  it("returns no language when the project has not recorded one", () => {
    expect(resolveSummarizerLanguage(testConfig(), dir, paths)).toBeUndefined();
  });

  it("canonicalizes configured language tags and rejects invalid values", () => {
    expect(resolveSummarizerLanguage({
      ...testConfig(),
      summarizer: { mock: false, language: "PT_br" },
    }, dir, paths)).toBe("pt-BR");

    expect(() => resolveSummarizerLanguage({
      ...testConfig(),
      summarizer: { mock: false, language: "i-am-not-a-tag" },
    }, dir, paths)).toThrow(/Invalid summarizer\.language.*BCP 47/);

    expect(() => resolveSummarizerLanguage({
      ...testConfig(),
      summarizer: { mock: false, language: 123 as unknown as string },
    }, dir, paths)).toThrow(/Invalid summarizer\.language.*BCP 47/);
  });
});
