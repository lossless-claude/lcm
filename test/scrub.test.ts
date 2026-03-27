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

  it("redacts npm tokens (npm_...)", () => {
    expect(engine.scrub("token=npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")).toContain("[REDACTED]");
  });

  it("redacts Slack bot tokens (xoxb-...)", () => {
    expect(engine.scrub("SLACK_TOKEN=xoxb-123456789-abcdefghij")).toContain("[REDACTED]");
  });

  it("redacts Slack user tokens (xoxp-...)", () => {
    expect(engine.scrub("token=xoxp-999888777-abcdef")).toContain("[REDACTED]");
  });

  it("redacts Slack rotating tokens (xoxe-...)", () => {
    expect(engine.scrub("token=xoxe-1-abc123def456")).toContain("[REDACTED]");
  });

  it("redacts Slack app-level tokens (xapp-...)", () => {
    expect(engine.scrub("token=xapp-1-A0B1C2D3E4F-abc123")).toContain("[REDACTED]");
  });

  it("redacts Slack workflow tokens (xwfp-...)", () => {
    expect(engine.scrub("token=xwfp-abc123-def456")).toContain("[REDACTED]");
  });

  it("redacts Stripe live secret keys (sk_live_...)", () => {
    expect(engine.scrub("key=sk_live_51J3kxABCDEFghijKLMNop")).toContain("[REDACTED]");
  });

  it("redacts Stripe live publishable keys (pk_live_...)", () => {
    expect(engine.scrub("key=pk_live_51J3kxABCDEFghijKLMNop")).toContain("[REDACTED]");
  });

  it("redacts Google/GCP API keys (AIza...)", () => {
    expect(engine.scrub("key=AIzaSyA1234567890abcdefghijklmnopqrstuv")).toContain("[REDACTED]");
  });

  it("redacts SendGrid API tokens (SG.…)", () => {
    expect(engine.scrub("SENDGRID_KEY=SG." + "a".repeat(66))).toContain("[REDACTED]");
  });

  it("redacts Twilio API keys (SK...)", () => {
    expect(engine.scrub("TWILIO_KEY=SK00000000000000000000000000000000")).toContain("[REDACTED]");
  });

  it("redacts Shopify access tokens (shpat_...)", () => {
    expect(engine.scrub("token=shpat_" + "a".repeat(32))).toContain("[REDACTED]");
  });

  it("redacts Vault service tokens (hvs.…)", () => {
    expect(engine.scrub("VAULT_TOKEN=hvs." + "a".repeat(95))).toContain("[REDACTED]");
  });

  it("redacts Doppler API tokens (dp.pt.…)", () => {
    expect(engine.scrub("DOPPLER=dp.pt." + "a".repeat(43))).toContain("[REDACTED]");
  });

  it("redacts database connection strings with credentials", () => {
    expect(engine.scrub("DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/mydb")).toContain("[REDACTED]");
    expect(engine.scrub("MONGO=mongodb://root:pass@mongo:27017/app")).toContain("[REDACTED]");
    expect(engine.scrub("REDIS=redis://default:hunter2@redis.example.com:6379")).toContain("[REDACTED]");
  });

  it("redacts JWTs (eyJ... three-segment tokens)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.aBcDeFgHiJkLmNoPqRsTuVwXyZ";
    expect(engine.scrub(`token=${jwt}`)).toContain("[REDACTED]");
  });

  it("does not redact partial JWT-like strings without dots", () => {
    expect(engine.scrub("eyJhbGciOiJIUzI1NiJ9")).not.toContain("[REDACTED]");
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
    expect(result.gitleaks).toBe(0);
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toBe("Hello world, this is safe content.");
  });

  it("counts gitleaks pattern matches (GitHub PAT)", () => {
    const engine = new ScrubEngine([], []);
    // ghp_ GitHub PAT — covered by both gitleaks and native; gitleaks wins (lower index)
    const result = engine.scrubWithCounts("token=ghp_" + "A".repeat(36));
    expect(result.gitleaks).toBeGreaterThan(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toContain("[REDACTED]");
  });

  it("counts built-in (native) pattern matches for strings not covered by gitleaks", () => {
    const engine = new ScrubEngine([], []);
    // Database connection URL — only in NATIVE_PATTERNS, not gitleaks
    const result = engine.scrubWithCounts("postgres://admin:s3cret@db.example.com:5432/mydb");
    expect(result.builtIn).toBeGreaterThan(0);
    expect(result.gitleaks).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toContain("[REDACTED]");
  });

  it("counts global pattern matches", () => {
    const engine = new ScrubEngine(["XUNIT_[A-Z0-9]+"], []);
    // XUNIT_ prefix doesn't appear in gitleaks or native patterns
    const result = engine.scrubWithCounts("XUNIT_ABC123");
    expect(result.gitleaks).toBe(0);
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(1);
    expect(result.project).toBe(0);
  });

  it("counts project pattern matches", () => {
    const engine = new ScrubEngine([], ["ZEBRA_[A-Z]+"]);
    // ZEBRA_ prefix doesn't appear in gitleaks or native patterns
    const result = engine.scrubWithCounts("ZEBRA_XYZ");
    expect(result.gitleaks).toBe(0);
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(1);
  });

  it("counts multiple matches across categories independently", () => {
    const engine = new ScrubEngine(["XUNIT_[A-Z0-9]+"], ["ZEBRA_[A-Z]+"]);
    // XUNIT_ (global) + ZEBRA_ (project) + DB URL (native/builtIn)
    const result = engine.scrubWithCounts("XUNIT_123 and ZEBRA_XYZ and postgres://admin:s3cret@db.example.com/mydb");
    expect(result.builtIn).toBeGreaterThan(0);
    expect(result.global).toBe(1);
    expect(result.project).toBe(1);
  });

  it("scrub() returns same text as scrubWithCounts().text", () => {
    const engine = new ScrubEngine(["XUNIT_[A-Z]+"], ["ZEBRA_[A-Z]+"]);
    const text = "XUNIT_ABC ZEBRA_XYZ safe text";
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
