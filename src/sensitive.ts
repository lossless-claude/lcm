import { readFile, writeFile, mkdir } from "node:fs/promises";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "./scrub.js";
import { GITLEAKS_PATTERNS } from "./generated-patterns.js";
import { projectDir } from "./daemon/project.js";
import { loadDaemonConfig } from "./daemon/config.js";

function defaultConfigPath(): string {
  return join(homedir(), ".lossless-claude", "config.json");
}

export async function handleSensitive(
  argv: string[],
  cwd: string,
  configPath?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const resolvedConfigPath = configPath ?? defaultConfigPath();
  const sub = argv[0];

  switch (sub) {
    case "list": {
      return sensitiveList(cwd, resolvedConfigPath);
    }
    case "add": {
      return sensitiveAdd(argv.slice(1), cwd, resolvedConfigPath);
    }
    case "remove": {
      return sensitiveRemove(argv.slice(1), cwd);
    }
    case "test": {
      return sensitiveTest(argv.slice(1), cwd, resolvedConfigPath);
    }
    case "purge": {
      return sensitivePurge(argv.slice(1), cwd);
    }
    default: {
      return {
        exitCode: 1,
        stdout:
          "Usage: lcm sensitive <list|add|remove|test|purge> [options]\n",
      };
    }
  }
}

async function sensitiveList(
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  let globalUserPatterns: string[] = [];
  try {
    const config = loadDaemonConfig(configPath);
    globalUserPatterns = config.security?.sensitivePatterns ?? [];
  } catch {
    // config may not exist yet
  }

  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

  const lines: string[] = [];
  const syncDate = readGitleaksSyncDate();
  const syncNote = syncDate ? ` (synced ${syncDate})` : "";

  lines.push("Built-in patterns:");
  lines.push(`  [gitleaks]  ${GITLEAKS_PATTERNS.length} patterns${syncNote}`);
  for (const p of NATIVE_PATTERNS) {
    lines.push(`  [native]    ${p}`);
  }

  lines.push("");
  lines.push("Global patterns (config.json):");
  if (globalUserPatterns.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of globalUserPatterns) {
      lines.push(`  [user]      ${p}`);
    }
  }

  lines.push("");
  lines.push(
    `Project patterns (${patternsFile}):`,
  );
  if (projectPatterns.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of projectPatterns) {
      lines.push(`  [user]      ${p}`);
    }
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

async function sensitiveAdd(
  args: string[],
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const isGlobal = args.includes("--global");
  const pattern = args.find((a) => !a.startsWith("--"));

  if (!pattern) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive add [--global] "<pattern>"\n',
    };
  }

  if (isGlobal) {
    // Read config.json, add to security.sensitivePatterns
    let raw: any = {};
    try {
      const content = await readFile(configPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Corrupt JSON — refuse to overwrite and destroy existing settings.
        return {
          exitCode: 1,
          stdout: `Error: ${configPath} contains invalid JSON. Fix the file manually before adding patterns.\n`,
        };
      }
      // Guard against non-object JSON values (arrays, primitives).
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed;
      } else {
        return {
          exitCode: 1,
          stdout: `Error: ${configPath} is not a JSON object. Fix the file manually before adding patterns.\n`,
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // File doesn't exist yet — start fresh with empty object.
    }
    if (!raw.security) raw.security = {};
    if (!Array.isArray(raw.security.sensitivePatterns)) {
      raw.security.sensitivePatterns = [];
    }
    if (raw.security.sensitivePatterns.includes(pattern)) {
      return { exitCode: 0, stdout: `Pattern already present (global): ${pattern}\n` };
    }
    raw.security.sensitivePatterns.push(pattern);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    return { exitCode: 0, stdout: `Added global pattern: ${pattern}\n` };
  }

  // Project-local
  const pDir = projectDir(cwd);
  await mkdir(pDir, { recursive: true });
  const patternsFile = join(pDir, "sensitive-patterns.txt");

  const existing = await ScrubEngine.loadProjectPatterns(patternsFile);
  if (existing.includes(pattern)) {
    return { exitCode: 0, stdout: `Pattern already present (project): ${pattern}\n` };
  }

  // Append to file
  const line = pattern + "\n";
  try {
    const current = await readFile(patternsFile, "utf-8");
    const normalized = current.length > 0 && !current.endsWith("\n") ? current + "\n" : current;
    await writeFile(patternsFile, normalized + line, "utf-8");
  } catch {
    // File doesn't exist yet
    await writeFile(patternsFile, line, "utf-8");
  }

  return { exitCode: 0, stdout: `Added project pattern: ${pattern}\n` };
}

async function sensitiveRemove(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const pattern = args.find((a) => !a.startsWith("--"));
  if (!pattern) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive remove "<pattern>"\n',
    };
  }

  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const existing = await ScrubEngine.loadProjectPatterns(patternsFile);

  if (!existing.includes(pattern)) {
    return {
      exitCode: 1,
      stdout: `Pattern not found in project patterns: ${pattern}\n`,
    };
  }

  // Read the raw file and remove only lines matching the pattern, preserving comments and blanks
  let raw = "";
  try {
    raw = await readFile(patternsFile, "utf-8");
  } catch {
    // file disappeared between load and remove — treat as already removed
  }
  const updatedLines = raw
    .split("\n")
    .filter((line) => line.trim() !== pattern);
  // Ensure single trailing newline
  const updatedContent = updatedLines.join("\n").replace(/\n+$/, "") + "\n";
  await writeFile(patternsFile, updatedContent, "utf-8");

  return { exitCode: 0, stdout: `Removed project pattern: ${pattern}\n` };
}

async function sensitiveTest(
  args: string[],
  cwd: string,
  configPath: string,
): Promise<{ exitCode: number; stdout: string }> {
  const input = args.find((a) => !a.startsWith("--"));
  if (input === undefined) {
    return {
      exitCode: 1,
      stdout: 'Usage: lcm sensitive test "<string>"\n',
    };
  }

  let globalUserPatterns: string[] = [];
  try {
    const config = loadDaemonConfig(configPath);
    globalUserPatterns = config.security?.sensitivePatterns ?? [];
  } catch {
    // config may not exist yet
  }
  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const engine = await ScrubEngine.forProject(globalUserPatterns, projectDir(cwd));

  const redacted = engine.scrub(input);

  const lines: string[] = [];

  // Find which patterns matched
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

  const matched: string[] = [];

  // Check gitleaks patterns first
  for (const p of GITLEAKS_PATTERNS) {
    try {
      if (new RegExp(p.regex, p.flags).test(input)) {
        matched.push(`  [gitleaks:${p.id}]  ${p.regex}`);
      }
    } catch {
      // invalid pattern — skip
    }
  }

  // Check native patterns
  for (const source of NATIVE_PATTERNS) {
    try {
      if (new RegExp(source).test(input)) {
        matched.push(`  [native]  ${source}`);
      }
    } catch {
      // invalid pattern — skip
    }
  }

  // Check global/project patterns
  const userPatterns = [
    ...globalUserPatterns.map((p) => ({ source: p, kind: "global" as const })),
    ...projectPatterns.map((p) => ({ source: p, kind: "project" as const })),
  ];
  for (const { source, kind } of userPatterns) {
    try {
      if (new RegExp(source).test(input)) {
        matched.push(`  [${kind}]  ${source}`);
      }
    } catch {
      // invalid pattern — skip
    }
  }

  if (matched.length === 0) {
    lines.push("No patterns matched.");
    lines.push(`Input:    ${input}`);
  } else {
    lines.push("Matched patterns:");
    lines.push(...matched);
    lines.push(`Input:    ${input}`);
    lines.push(`Redacted: ${redacted}`);
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

async function sensitivePurge(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const hasYes = args.includes("--yes");
  const purgeAll = args.includes("--all");

  if (!hasYes) {
    return {
      exitCode: 1,
      stdout:
        "Error: lcm sensitive purge requires --yes to confirm.\n" +
        "  lcm sensitive purge --yes           (current project)\n" +
        "  lcm sensitive purge --all --yes      (all projects)\n",
    };
  }

  const { join: pathJoin } = await import("node:path");
  const { homedir: hd } = await import("node:os");

  if (purgeAll) {
    const allProjectsDir = pathJoin(hd(), ".lossless-claude", "projects");
    if (existsSync(allProjectsDir)) {
      rmSync(allProjectsDir, { recursive: true, force: true });
      return {
        exitCode: 0,
        stdout: `Purged all project data: ${allProjectsDir}\n`,
      };
    }
    return { exitCode: 0, stdout: "No project data to purge.\n" };
  }

  // Current project only
  const pDir = projectDir(cwd);
  if (existsSync(pDir)) {
    rmSync(pDir, { recursive: true, force: true });
    return { exitCode: 0, stdout: `Purged project data: ${pDir}\n` };
  }
  return { exitCode: 0, stdout: "No project data to purge.\n" };
}
