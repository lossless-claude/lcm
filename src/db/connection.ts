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
