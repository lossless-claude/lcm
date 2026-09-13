#!/usr/bin/env node
// Builds the plugin artifact: `bundle/lcm.js` (the CLI, hooks and daemon entry),
// `bundle/mcp-server.js` (the MCP server) and `bundle/assets/` (prompt YAML,
// connector templates, setup.sh). A marketplace install runs from these with only
// a `node` on PATH: no npm install, no compile step, no `lcm` binary.
//
// `dist/` stays the npm artifact and is built by `npm run build`; this script is
// separate so an ordinary build never touches the tracked `bundle/`, which only
// changes in version PRs (see docs/releasing.md).
//
// The version and build id are injected as defines because from `bundle/` neither
// `package.json` nor `dist/BUILD_ID` is reachable, and an undefined version would
// silently disable the daemon ownership check. Run `npm run build` first: the build
// id is read from `dist/BUILD_ID`, so the bundle and the npm package of one build
// report the same fingerprint.
//
// Usage: node scripts/build-bundle.mjs [outDir]   (default: ./bundle)

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildBundle({ root = repoRoot, outDir = join(root, "bundle"), version, buildId } = {}) {
  version ??= JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const buildIdPath = join(root, "dist", "BUILD_ID");
  if (buildId === undefined && !existsSync(buildIdPath)) {
    throw new Error(`build-bundle: ${buildIdPath} missing — run \`npm run build\` first`);
  }
  buildId ??= readFileSync(buildIdPath, "utf8").trim();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    absWorkingDir: root,
    logLevel: "warning",
    define: {
      __PKG_VERSION__: JSON.stringify(version),
      __BUILD_ID__: JSON.stringify(buildId),
    },
    // Dependencies written as CommonJS need `require` in an ESM bundle.
    banner: { js: 'import { createRequire as __lcmCreateRequire } from "node:module"; const require = __lcmCreateRequire(import.meta.url);' },
  };

  await build({ ...common, entryPoints: [join(root, "bin", "lcm.ts")], outfile: join(outDir, "lcm.js") });
  await build({
    ...common,
    stdin: {
      contents: 'import { startMcpServer } from "./src/mcp/server.js";\nawait startMcpServer();\n',
      resolveDir: root,
      loader: "ts",
    },
    outfile: join(outDir, "mcp-server.js"),
  });

  const assets = join(outDir, "assets");
  mkdirSync(join(assets, "prompts"), { recursive: true });
  cpSync(join(root, "src", "prompts"), join(assets, "prompts"), { recursive: true, filter: (src) => !src.endsWith(".ts") });
  cpSync(join(root, "src", "connectors", "templates"), join(assets, "templates"), { recursive: true });
  cpSync(join(root, "installer", "setup.sh"), join(assets, "setup.sh"));

  return { outDir, version, buildId };
}

function isMain() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  // Resolved against the repository, like esbuild's own outfile, never against cwd.
  const outDir = process.argv[2] ? resolve(repoRoot, process.argv[2]) : undefined;
  const result = await buildBundle(outDir ? { outDir } : {});
  console.log(`build-bundle: ${result.outDir} (v${result.version}, build ${result.buildId})`);
}
