import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function ensureAuthToken(tokenPath: string): void {
  if (existsSync(tokenPath)) {
    try { chmodSync(tokenPath, 0o600); } catch {}
    return;
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch {}
}

export function readAuthToken(tokenPath: string): string | null {
  try {
    return readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return null;
  }
}
