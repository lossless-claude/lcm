import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { createSummarizer } from "../../src/daemon/summarizer.js";
import { loadDaemonConfig, type DaemonConfig } from "../../src/daemon/config.js";
import { resetProjectLanguageState, scheduleProjectLanguageDetection } from "../../src/daemon/project-language.js";
import { invalidateLanguagePacks, languagePackPath } from "../../src/store/language-pack.js";

let dir: string;
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
function testConfig(llm: Partial<DaemonConfig["llm"]> = {}): DaemonConfig {
  return loadDaemonConfig(
    join(tmpdir(), "lcm-no-such-config.json"),
    { llm: { provider: "openai", model: "test-model", baseURL: "http://local.test", apiKey: "k", ...llm } },
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
  it("records the language in meta.json and generates the pack, once", async () => {
    const summarize = vi.fn().mockResolvedValueOnce("pt-BR").mockResolvedValueOnce(PACK_REPLY);
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    const db = await seededDb(25);
    await scheduleProjectLanguageDetection(dir, db, testConfig());
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.language).toBe("pt-BR");
    expect(existsSync(languagePackPath("pt-BR"))).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0][0]).toContain("1. Bora revisar");
    await scheduleProjectLanguageDetection(dir, db, testConfig());
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("does nothing below the turn threshold, under a mock summarizer, or with a disabled provider", async () => {
    const summarize = vi.fn().mockResolvedValue("pt-BR");
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(5), testConfig());
    await scheduleProjectLanguageDetection(dir, await seededDb(25), { ...testConfig(), summarizer: { mock: true } });
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig({ provider: "disabled" }));
    expect(summarize).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "meta.json"))).toBe(false);
  });

  it("keeps an existing language and never re-detects it", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: dir, language: "de" }));
    const summarize = vi.fn().mockResolvedValue("pt-BR");
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    await scheduleProjectLanguageDetection(dir, await seededDb(25), testConfig());
    expect(summarize).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")).language).toBe("de");
  });

  it("warns once and stops retrying when the provider fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summarize = vi.fn().mockRejectedValue(new Error("API key is invalid"));
    vi.mocked(createSummarizer).mockResolvedValue(summarize);
    const db = await seededDb(25);
    await scheduleProjectLanguageDetection(dir, db, testConfig());
    await scheduleProjectLanguageDetection(dir, db, testConfig());
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("API key is invalid");
    expect(existsSync(join(dir, "meta.json"))).toBe(false);
    warn.mockRestore();
  });
});
