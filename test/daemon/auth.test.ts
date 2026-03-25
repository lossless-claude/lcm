import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("ensureAuthToken", () => {
  it("generates a token file with 0o600 permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-auth-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const token = readFileSync(tokenPath, "utf-8").trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("preserves existing token on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-auth2-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const first = readFileSync(tokenPath, "utf-8");
    ensureAuthToken(tokenPath);
    const second = readFileSync(tokenPath, "utf-8");
    expect(first).toBe(second);
  });
});

describe("readAuthToken", () => {
  it("returns the token from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-auth3-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "daemon.token");
    writeFileSync(tokenPath, "test-token-123");
    expect(readAuthToken(tokenPath)).toBe("test-token-123");
  });

  it("returns null when file does not exist", () => {
    expect(readAuthToken("/nonexistent/daemon.token")).toBeNull();
  });
});
