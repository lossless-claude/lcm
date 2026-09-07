import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareRgCorpus, searchRg } from "../../src/bench/rg-baseline.js";

function hasRg(): boolean {
  try {
    execSync("rg --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasRg())("ripgrep baseline", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lcm-rg-test-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("attributes multi-line matches to the right document and ranks by matched terms then occurrences", async () => {
    const corpus = await prepareRgCorpus(
      [
        { id: "a", text: "first line\nalpha beta\nalpha again" },
        { id: "b", text: "beta only" },
        { id: "c", text: "nothing here\nat all" },
        { id: "d", text: "ALPHA and Beta on one line" },
      ],
      dir,
    );
    expect(corpus.documents).toBe(4);
    expect(corpus.spans.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);

    const result = await searchRg(corpus, ["alpha", "beta"], 10);
    expect(result.hits.map((h) => h.id)).toEqual(["a", "d", "b"]);
    expect(result.hits[0]).toMatchObject({ id: "a", matchedTerms: 2, occurrences: 3 });
    expect(result.hits[1]).toMatchObject({ id: "d", matchedTerms: 2, occurrences: 2 });
    expect(result.hits[2]).toMatchObject({ id: "b", matchedTerms: 1, occurrences: 1 });
    expect(result.matchedLines).toBe(4);

    const limited = await searchRg(corpus, ["beta"], 1);
    expect(limited.hits).toHaveLength(1);
  });

  it("rejects duplicate ids and unusable terms", async () => {
    await expect(prepareRgCorpus([{ id: "x", text: "1" }, { id: "x", text: "2" }], join(dir, "dup"))).rejects.toThrow(/unique/);
    const corpus = await prepareRgCorpus([{ id: "x", text: "1" }], join(dir, "ok"));
    await expect(searchRg(corpus, ["a\nb"], 1)).rejects.toThrow(/single-line/);
    await expect(searchRg(corpus, ["a"], 0)).rejects.toThrow(/positive/);
  });
});
