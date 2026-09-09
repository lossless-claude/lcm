import { registerDaemonActivity } from "../daemon/lifecycle.js";
import { readHold } from "../daemon/hold.js";
import { lcmPath } from "../lcm-home.js";

/** Admit synchronous hook writes before opening SQLite; held stops drain admitted work. */
export function withHookWrite<T>(write: () => T, heldResult: T): T {
  const pidPath = lcmPath("daemon.pid");
  const unregister = registerDaemonActivity(pidPath);
  try {
    return readHold(pidPath) ? heldResult : write();
  } finally {
    unregister();
  }
}
