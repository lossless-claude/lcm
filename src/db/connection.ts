import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

type ConnectionEntry = {
  db: DatabaseSync;
  refs: number;
};

const _connections = new Map<string, ConnectionEntry>();

function isConnectionHealthy(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function forceCloseConnection(entry: ConnectionEntry): void {
  try {
    entry.db.close();
  } catch {
    // Ignore close failures; caller is already replacing/removing this handle.
  }
}

export function getLcmConnection(dbPath: string): DatabaseSync {
  // No TOCTOU race here: Node.js is single-threaded and this function is
  // synchronous. There is no await/yield between the health check and the
  // refs increment, so no other caller can interleave and close the connection
  // in between. The sequence (check => increment => return) is atomic w.r.t.
  // the JavaScript event loop.
  const existing = _connections.get(dbPath);
  if (existing) {
    if (isConnectionHealthy(existing.db)) {
      existing.refs += 1;
      return existing.db;
    }
    forceCloseConnection(existing);
    _connections.delete(dbPath);
  }

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  // Wait up to 5 seconds on busy instead of failing immediately
  db.exec("PRAGMA busy_timeout = 5000");
  // Enable foreign key enforcement
  db.exec("PRAGMA foreign_keys = ON");

  _connections.set(dbPath, { db, refs: 1 });
  return db;
}

export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  connections: Array<{
    path: string;
    refs: number;
    status: "active" | "idle";
  }>;
}

export function getPoolStats(): PoolStats {
  const connections = Array.from(_connections.entries()).map(([path, entry]) => ({
    path,
    refs: entry.refs,
    status: (entry.refs > 0 ? "active" : "idle") as "active" | "idle",
  }));
  const activeConnections = connections.filter((c) => c.status === "active").length;
  return {
    totalConnections: connections.length,
    activeConnections,
    idleConnections: connections.length - activeConnections,
    connections,
  };
}

/**
 * Returns true if a pooled connection for dbPath is currently open (refs > 0).
 * Used by callers that track per-connection state (e.g., migration-done cache)
 * so they can invalidate their state when the underlying connection is evicted.
 */
export function isLcmConnectionOpen(dbPath: string): boolean {
  return _connections.has(dbPath);
}

export function closeLcmConnection(dbPath?: string): void {
  if (typeof dbPath === "string" && dbPath.trim()) {
    const entry = _connections.get(dbPath);
    if (!entry) {
      return;
    }
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      forceCloseConnection(entry);
      _connections.delete(dbPath);
    }
    return;
  }

  for (const entry of _connections.values()) {
    forceCloseConnection(entry);
  }
  _connections.clear();
}
