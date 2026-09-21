import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "../scripts/write-build-id.mjs";

// Runs before every test file, alongside `setup-env.ts`.
//
// Several suites spawn the *built* CLI (`dist/bin/lcm.js`) and compare what it prints against
// committed expectations — golden snapshots, help routing, hold behaviour, e2e flows. They
// used to run against whatever `dist/` happened to be on disk, so a developer who edited a
// source file and did not rebuild got green tests locally and a red CI run, at the price of
// one confused debugging session per occurrence.
//
// Every build records the fingerprint of the sources it was made from in
// `dist/BUILD_SOURCES`; this refuses to start the suite when the working tree no longer
// matches it. A `dist/` with no such file is unprovable, so it counts as stale too.
//
// Deliberately silent when `dist/` was never built: a unit-test run that needs no build is
// still allowed, and the suites that do need one say so themselves.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(root, "dist", "bin", "lcm.js");
const sourcesFile = join(root, "dist", "BUILD_SOURCES");

if (existsSync(cliEntry)) {
  const recorded = existsSync(sourcesFile) ? readFileSync(sourcesFile, "utf8").trim() : null;
  const actual = sourceFingerprint(root);
  if (recorded !== actual) {
    throw new Error(
      "dist/ was not built from the current sources, so any test that runs the built CLI " +
        "(golden snapshots, help routing, e2e flows) would be testing the wrong binary.\n" +
        `  dist/BUILD_SOURCES: ${recorded ?? "(missing)"}\n` +
        `  current sources:    ${actual}\n` +
        "Rebuild first: LCM_SKIP_CACHE_SYNC=1 npm run build",
    );
  }
}
