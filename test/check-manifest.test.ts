import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkManifest } from "../scripts/check-manifest.mjs";
import { syncVersions } from "../scripts/sync-versions.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "lcm-check-manifest-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  return root;
}

function writePackageJson(root: string, overrides: Record<string, unknown> = {}) {
  const pkg = {
    name: "@lossless-claude/lcm",
    version: "1.0.0",
    dependencies: {},
    peerDependencies: {},
    devDependencies: {},
    ...overrides,
  };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

function writePluginManifests(root: string, pluginVersion: string, marketplaceVersion: string) {
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "lcm", version: pluginVersion }, null, 2) + "\n"
  );
  writeFileSync(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "lossless-claude", plugins: [{ name: "lcm", version: marketplaceVersion }] }, null, 2) + "\n"
  );
}

function writeDistFile(root: string, relPath: string, content: string) {
  const full = join(root, "dist", relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("checkManifest — rule (a): declared imports", () => {
  it("fails on an import that is not declared anywhere", () => {
    const root = makeFixture();
    writePackageJson(root);
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `import { foo } from "left-pad";\n`);

    const findings = checkManifest(root);
    expect(findings.some((f) => f.includes("left-pad"))).toBe(true);
  });

  it("passes when the import is only a peerDependency", () => {
    const root = makeFixture();
    writePackageJson(root, { peerDependencies: { openai: "^6.0.0" } });
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `import OpenAI from "openai";\n`);

    const findings = checkManifest(root);
    expect(findings).toEqual([]);
  });

  it("fails when the import is declared only as a devDependency", () => {
    const root = makeFixture();
    writePackageJson(root, { devDependencies: { openai: "^6.0.0" } });
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `import OpenAI from "openai";\n`);

    const findings = checkManifest(root);
    expect(findings.some((f) => f.includes("openai"))).toBe(true);
  });

  it("ignores node: builtins and relative imports", () => {
    const root = makeFixture();
    writePackageJson(root, { dependencies: { commander: "^14.0.0" } });
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(
      root,
      "index.js",
      `import { readFileSync } from "node:fs";\n` +
        `import { helper } from "./helper.js";\n` +
        `import { program } from "commander";\n`
    );
    writeDistFile(root, "helper.js", `export const helper = 1;\n`);

    const findings = checkManifest(root);
    expect(findings).toEqual([]);
  });

  it("resolves a scoped subpath import to its package name", () => {
    const root = makeFixture();
    writePackageJson(root, { dependencies: { "@scope/pkg": "^1.0.0" } });
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `import { thing } from "@scope/pkg/sub";\n`);

    const findings = checkManifest(root);
    expect(findings).toEqual([]);
  });

  it("fails noisily when dist/ is missing", () => {
    const root = makeFixture();
    writePackageJson(root);
    writePluginManifests(root, "1.0.0", "1.0.0");

    const findings = checkManifest(root);
    expect(findings.some((f) => f.toLowerCase().includes("dist"))).toBe(true);
  });

  it("fails noisily when dist/ has no code files", () => {
    const root = makeFixture();
    writePackageJson(root);
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "README.md", "not code");

    const findings = checkManifest(root);
    expect(findings.some((f) => f.toLowerCase().includes("dist"))).toBe(true);
  });

  it("fails noisily when the scan finds zero external imports", () => {
    const root = makeFixture();
    writePackageJson(root);
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `const x = 1;\nexport { x };\n`);

    const findings = checkManifest(root);
    expect(findings.some((f) => f.includes("zero external imports"))).toBe(true);
  });
});

describe("checkManifest — rule (b): version parity", () => {
  it("fails when the three versions are out of step", () => {
    const root = makeFixture();
    writePackageJson(root, { dependencies: { openai: "^6.0.0" } });
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `import OpenAI from "openai";\n`);
    // Bump only package.json.
    writePackageJson(root, { version: "1.1.0", dependencies: { openai: "^6.0.0" } });

    const findings = checkManifest(root);
    expect(findings.some((f) => f.includes("Version mismatch"))).toBe(true);
  });

  it("fails when only the marketplace version diverges", () => {
    const root = makeFixture();
    writePackageJson(root, { dependencies: { openai: "^6.0.0" } });
    writePluginManifests(root, "1.0.0", "0.9.0");
    writeDistFile(root, "index.js", `import OpenAI from "openai";\n`);

    const findings = checkManifest(root);
    expect(findings.some((f) => f.includes("Version mismatch"))).toBe(true);
  });

  it("passes when all three versions match and imports are declared", () => {
    const root = makeFixture();
    writePackageJson(root, { dependencies: { openai: "^6.0.0" } });
    writePluginManifests(root, "1.0.0", "1.0.0");
    writeDistFile(root, "index.js", `import OpenAI from "openai";\n`);

    const findings = checkManifest(root);
    expect(findings).toEqual([]);
  });
});

describe("syncVersions", () => {
  it("brings plugin.json and marketplace.json in step and preserves formatting", () => {
    const root = makeFixture();
    writePackageJson(root, { version: "2.3.4" });
    writePluginManifests(root, "1.0.0", "1.0.0");

    const pluginPath = join(root, ".claude-plugin", "plugin.json");
    const marketplacePath = join(root, ".claude-plugin", "marketplace.json");
    const beforePlugin = readFileSync(pluginPath, "utf8");
    const beforeMarketplace = readFileSync(marketplacePath, "utf8");

    syncVersions(root, "2.3.4");

    const afterPlugin = readFileSync(pluginPath, "utf8");
    const afterMarketplace = readFileSync(marketplacePath, "utf8");

    expect(JSON.parse(afterPlugin).version).toBe("2.3.4");
    expect(JSON.parse(afterMarketplace).plugins[0].version).toBe("2.3.4");

    // Formatting preserved: same indentation width and trailing newline.
    expect(afterPlugin.endsWith("\n")).toBe(beforePlugin.endsWith("\n"));
    expect(afterMarketplace.endsWith("\n")).toBe(beforeMarketplace.endsWith("\n"));
    expect(afterPlugin.match(/^ +/m)?.[0]).toBe(beforePlugin.match(/^ +/m)?.[0]);
    expect(afterMarketplace.match(/^ +/m)?.[0]).toBe(beforeMarketplace.match(/^ +/m)?.[0]);

    // The synced files now satisfy the version-parity rule they feed.
    writeDistFile(root, "index.js", `export const x = 1;\nimport "left-pad";\n`);
    // (left-pad import intentionally undeclared to isolate the version check —
    // rule (a) finding is not asserted here.)
    const findings = checkManifest(root).filter((f) => f.includes("Version mismatch"));
    expect(findings).toEqual([]);
  });

  it("throws a clear error when marketplace.json has no plugins[0]", () => {
    const root = makeFixture();
    writePackageJson(root, { version: "2.3.4" });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [] }, null, 2) + "\n");

    expect(() => syncVersions(root, "2.3.4")).toThrow(/plugins\[0\]/);
  });
});
