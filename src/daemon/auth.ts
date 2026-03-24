import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKEN_PATH = join(homedir(), ".lossless-claude", "daemon.token");

/**
 * Generates a 256-bit token on first run, persists it at ~/.lossless-claude/daemon.token
 * with mode 0o600, and returns the token value. Idempotent — returns existing token if valid.
 */
export function ensureAuthToken(): string {
  if (existsSync(TOKEN_PATH)) {
    const existing = readFileSync(TOKEN_PATH, "utf-8").trim();
    if (existing.length === 64) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

/**
 * Reads the stored daemon token from disk.
 * Returns null if the token file does not exist or is unreadable.
 */
export function readAuthToken(): string | null {
  try {
    const t = readFileSync(TOKEN_PATH, "utf-8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
