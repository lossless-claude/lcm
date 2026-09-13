import { registerDaemonActivity } from "../daemon/lifecycle.js";
import { readHold } from "../daemon/hold.js";
import type { LcmPaths } from "../lcm-paths.js";

/** Admit synchronous hook writes before opening SQLite; held stops drain admitted work. */
export function withHookWrite<T>(paths: LcmPaths, write: () => T, heldResult: T): T {
  const pidPath = paths.pidPath;
  const unregister = registerDaemonActivity(pidPath);
  try {
    return readHold(pidPath) ? heldResult : write();
  } finally {
    unregister();
  }
}
