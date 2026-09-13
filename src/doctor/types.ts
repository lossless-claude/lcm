export interface CheckResult {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixApplied?: boolean;
}

/**
 * Which failing checks `lcm install` counts as its own: the categories it sets up,
 * minus the checks whose repair is updating this distribution (`claude plugin
 * update` / `npm install -g`), which install cannot perform.
 */
export const INSTALL_OWNED_CATEGORIES: ReadonlySet<string> = new Set(["Stack", "Daemon", "Settings"]);
export const INSTALL_EXTERNAL_CHECKS: ReadonlySet<string> = new Set(["plugin-bundle", "daemon-version"]);

export function blocksInstall(result: Pick<CheckResult, "name" | "category" | "status">): boolean {
  return result.status === "fail"
    && !INSTALL_EXTERNAL_CHECKS.has(result.name)
    && (result.category === undefined || INSTALL_OWNED_CATEGORIES.has(result.category));
}

export interface DoctorDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  spawnSync: (cmd: string, args: string[], opts?: object) => { status: number | null; stdout: string; stderr: string };
  fetch: typeof globalThis.fetch;
  homedir: string;
  /** Where lcm stores things: `~/.lossless-claude`, or wherever LCM_HOME points. */
  lcmHome: string;
  platform: string;
  cwd?: string;
}
