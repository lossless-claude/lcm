import type { DatabaseSync } from "node:sqlite";
import type { SessionUrlDeclaration } from "../transcript.js";

/** Exact transcript declarations only; message content never establishes web identity. */
export function recordSessionWebUrls(db: DatabaseSync, sessionId: string, declarations: SessionUrlDeclaration[]): void {
  if (declarations.length === 0) return;
  const insert = db.prepare("INSERT OR IGNORE INTO session_web_urls(session_id, url) VALUES (?, ?)");
  for (const declaration of declarations) {
    if (declaration.sessionId === sessionId) insert.run(sessionId, declaration.url);
  }
}
