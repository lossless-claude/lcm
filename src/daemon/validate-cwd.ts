import { resolve, isAbsolute } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { sanitizeError } from "./safe-error.js";

/**
 * Canonicalize and validate a cwd parameter from a daemon route.
 * Ensures consistent project ID hashing regardless of path formatting.
 */
export function validateCwd(cwd: string): string {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("cwd is required");
  }
  if (!isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }
  const resolved = resolve(cwd);
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("cwd must be a directory");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(sanitizeError(`cwd does not exist: ${resolved}`));
    }
    // Sanitize all other filesystem errors (e.g. EACCES) to avoid leaking absolute paths.
    const msg = err instanceof Error ? err.message : "filesystem error";
    throw new Error(sanitizeError(msg));
  }
  // Resolve symlinks so /tmp and /private/tmp map to the same project ID on macOS.
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
