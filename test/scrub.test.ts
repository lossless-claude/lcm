import { describe, it, expect, afterEach } from "vitest";
import { ScrubEngine } from "../src/scrub.js";

describe("ScrubEngine — built-in patterns", () => {
  const engine = new ScrubEngine([], []);

  it("redacts OpenAI keys (sk-...)", () => {
    expect(engine.scrub("key=sk-abcdefghijklmnopqrstu")).toContain("[REDACTED]");
  });

  it("redacts Anthropic keys (sk-ant-...)", () => {
    expect(engine.scrub("key=sk-ant-api03-" + "a".repeat(40))).toContain("[REDACTED]");
  });

  it("redacts GitHub PATs (ghp_...)", () => {
    expect(engine.scrub("token=ghp_" + "A".repeat(36))).toContain("[REDACTED]");
  });

  it("redacts AWS access key IDs (AKIA...)", () => {
    expect(engine.scrub("aws_access_key_id=AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(engine.scrub("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9")).toContain("[REDACTED]");
  });

  it("redacts PEM key headers", () => {
    expect(engine.scrub("-----BEGIN RSA KEY-----")).toContain("[REDACTED]");
  });

  it("does not redact normal text", () => {
    const text = "Hello world, this is safe content.";
    expect(engine.scrub(text)).toBe(text);
  });
});

describe("ScrubEngine — custom patterns", () => {
  it("applies user-defined global patterns", () => {
    const engine = new ScrubEngine(["MY_TOKEN_[A-Z0-9]+"], []);
    expect(engine.scrub("token=MY_TOKEN_ABC123")).toContain("[REDACTED]");
  });

  it("applies per-project patterns", () => {
    const engine = new ScrubEngine([], ["PROJ_SECRET_[A-Z]+"]);
    expect(engine.scrub("secret=PROJ_SECRET_XYZ")).toContain("[REDACTED]");
  });

  it("global patterns precede project patterns (merge order)", () => {
    const engine = new ScrubEngine(["GLOBAL_[A-Z0-9]+"], ["LOCAL_[A-Z0-9]+"]);
    expect(engine.scrub("GLOBAL_123 and LOCAL_456")).toBe("[REDACTED] and [REDACTED]");
  });

  it("warns and skips invalid regex patterns, continues scrubbing valid ones", () => {
    const engine = new ScrubEngine(["[invalid"], ["VALID_[A-Z]+"]);
    expect(engine.scrub("VALID_ABC")).toContain("[REDACTED]");
    expect(engine.invalidPatterns).toContain("[invalid");
  });
});

describe("ScrubEngine.scrubWithCounts", () => {
  it("returns zero counts when nothing is redacted", () => {
    const engine = new ScrubEngine([], []);
    const result = engine.scrubWithCounts("Hello world, this is safe content.");
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toBe("Hello world, this is safe content.");
  });

  it("counts built-in pattern matches", () => {
    const engine = new ScrubEngine([], []);
    const result = engine.scrubWithCounts("token=ghp_" + "A".repeat(36));
    expect(result.builtIn).toBeGreaterThan(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toContain("[REDACTED]");
  });

  it("counts global pattern matches", () => {
    const engine = new ScrubEngine(["MY_TOKEN_[A-Z0-9]+"], []);
    const result = engine.scrubWithCounts("token=MY_TOKEN_ABC123");
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(1);
    expect(result.project).toBe(0);
  });

  it("counts project pattern matches", () => {
    const engine = new ScrubEngine([], ["PROJ_SECRET_[A-Z]+"]);
    const result = engine.scrubWithCounts("secret=PROJ_SECRET_XYZ");
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(1);
  });

  it("counts multiple matches across categories independently", () => {
    const engine = new ScrubEngine(["GLOBAL_[A-Z0-9]+"], ["LOCAL_[A-Z0-9]+"]);
    const result = engine.scrubWithCounts("GLOBAL_123 and LOCAL_456 and token=ghp_" + "A".repeat(36));
    expect(result.builtIn).toBeGreaterThan(0);
    expect(result.global).toBe(1);
    expect(result.project).toBe(1);
  });

  it("scrub() returns same text as scrubWithCounts().text", () => {
    const engine = new ScrubEngine(["GLOBAL_[A-Z]+"], ["LOCAL_[A-Z]+"]);
    const text = "GLOBAL_ABC LOCAL_XYZ safe text";
    expect(engine.scrub(text)).toBe(engine.scrubWithCounts(text).text);
  });
});

describe("ScrubEngine.loadProjectPatterns", () => {
  let tmpFile: string | undefined;

  afterEach(async () => {
    if (tmpFile) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpFile, { force: true });
      tmpFile = undefined;
    }
  });

  it("parses patterns file, ignoring comment lines and blanks", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    tmpFile = join(tmpdir(), `scrub-test-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(tmpFile, "# comment\nMY_PAT\n\n# another comment\nSECRET_KEY\n");
    const patterns = await ScrubEngine.loadProjectPatterns(tmpFile);
    expect(patterns).toEqual(["MY_PAT", "SECRET_KEY"]);
  });

  it("returns empty array when file does not exist", async () => {
    const patterns = await ScrubEngine.loadProjectPatterns("/nonexistent/path.txt");
    expect(patterns).toEqual([]);
  });

  it("rethrows non-ENOENT errors", async () => {
    await expect(ScrubEngine.loadProjectPatterns("/")).rejects.toThrow();
  });
});
