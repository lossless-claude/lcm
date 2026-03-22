export interface CheckResult {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixApplied?: boolean;
}

export interface DoctorDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  spawnSync: (cmd: string, args: string[], opts?: object) => { status: number | null; stdout: string; stderr: string };
  fetch: typeof globalThis.fetch;
  homedir: string;
  platform: string;
  cwd?: string;
}
