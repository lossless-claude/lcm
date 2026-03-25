import { randomBytes } from "node:crypto";
import { existsSync, openSync, writeSync, closeSync, readFileSync, chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export function ensureAuthToken(tokenPath: string): void {
  if (existsSync(tokenPath)) {
    try { chmodSync(tokenPath, 0o600); } catch {}
    return;
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  // Write to a temp file then atomically rename — immune to symlink races
  const tmpPath = join(tmpdir(), `lcm-token-${randomBytes(8).toString("hex")}`);
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, tokenPath);
  try { chmodSync(tokenPath, 0o600); } catch {}
}

export function readAuthToken(tokenPath: string): string | null {
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}
