import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";

/**
 * A project's git coordinates: the repository it belongs to, expressed as the
 * set of remotes that identify it, and where inside that repository it sits.
 *
 * The remote set is a set, not a scalar, so an org transfer or an `git@` to
 * `https` switch adds an alias instead of losing the grouping.
 */
export interface GitIdentity {
  /** Normalised remotes, sorted and deduplicated. Empty for a repo with no remote. */
  remotes: string[];
  /** Absolute path of the working tree root. */
  root: string;
  /** Path of the project relative to the root; "" at the root itself. */
  relPath: string;
}

/**
 * Normalises a remote URL to `host/path`, so that the same repository reached
 * over ssh, https or the scp-like syntax yields one identity.
 *
 * Returns null for anything that does not parse as a remote (a local path, a
 * malformed URL).
 */
export function normaliseRemote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  // scp-like syntax: [user@]host:path
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const parsed = scp
    ? { host: scp[1], path: scp[2] }
    : parseUrlRemote(trimmed);
  if (!parsed) return null;

  const host = parsed.host.toLowerCase();
  const path = parsed.path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (host === "" || path === "") return null;
  return `${host}/${path}`;
}

function parseUrlRemote(url: string): { host: string; path: string } | null {
  try {
    const { hostname, pathname, protocol } = new URL(url);
    if (protocol === "file:" || hostname === "") return null;
    return { host: hostname, path: pathname };
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Reads the git identity of `cwd`, or null when it is not inside a working tree
 * (or git is unavailable). A linked worktree reports its own root, which shares
 * its remotes with the main checkout, so the two land in the same group.
 */
export function discoverGitIdentity(cwd: string): GitIdentity | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;

  const remoteOutput = git(cwd, ["remote", "-v"]) ?? "";
  const remotes = new Set<string>();
  for (const line of remoteOutput.split("\n")) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    const normalised = normaliseRemote(url);
    if (normalised) remotes.add(normalised);
  }

  // `--show-toplevel` reports a canonicalised path; canonicalise `cwd` too so a
  // symlinked ancestor does not turn into a spurious `../..` relative path.
  let here = cwd;
  try { here = realpathSync(cwd); } catch { /* keep cwd */ }
  const relPath = relative(root, here).split("\\").join("/");
  return {
    remotes: [...remotes].sort(),
    root,
    relPath: relPath === "." ? "" : relPath,
  };
}
