# Optional: enable FTS5 for fast full-text search

`lcm` works without FTS5. When FTS5 is unavailable in the Node runtime the daemon runs on, lcm:

- keeps persisting messages and summaries
- falls back from FTS5 search to a slower `LIKE`-based search
- loses FTS ranking/snippet quality

lcm uses Node's built-in `node:sqlite` module (`src/db/features.ts` probes it at startup), not
`better-sqlite3`. Official Node 22 builds already compile SQLite with FTS5 enabled — most
installs need nothing further. Run the probe below first; only build a custom Node (last
section) if it reports `fts5: fail`.

The daemon always runs on `process.execPath` — the same Node binary that started it, whether
that is a `lcm daemon start` you ran yourself or the one Claude Code's or Codex's hook command
resolved from `PATH`. There is no separate runtime to point at; whichever Node is first on
`PATH` when the daemon is (re)started is the one that must have FTS5.

## Probe your Node runtime

Run this with the same `node` binary that starts the daemon:

```bash
node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
const options = db.prepare('pragma compile_options').all().map((row) => row.compile_options);

console.log(options.filter((value) => value.includes('FTS')).join('\n') || 'no fts compile options');

try {
  db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
  console.log("fts5: ok");
} catch (err) {
  console.log("fts5: fail");
  console.log(err instanceof Error ? err.message : String(err));
}
NODE
```

Expected output:

```text
ENABLE_FTS5
fts5: ok
```

If you get `fts5: fail`, either switch to an official Node 22+ build (nodejs.org, Homebrew, or
nvm all ship FTS5-enabled binaries) or build one yourself.

## Build an FTS5-capable Node on macOS

Only needed if your runtime lacks FTS5 — for example a distro-packaged Node built without it.

```bash
cd ~/Projects
git clone --depth 1 --branch v22.15.0 https://github.com/nodejs/node.git node-fts5
cd node-fts5
```

Edit `deps/sqlite/sqlite.gyp` and add `SQLITE_ENABLE_FTS5` to the `defines` list for the `sqlite`
target:

```diff
 'defines': [
   'SQLITE_DEFAULT_MEMSTATUS=0',
+  'SQLITE_ENABLE_FTS5',
   'SQLITE_ENABLE_MATH_FUNCTIONS',
   'SQLITE_ENABLE_SESSION',
   'SQLITE_ENABLE_PREUPDATE_HOOK'
 ],
```

Important:

- patch `deps/sqlite/sqlite.gyp`, not only `node.gyp`
- `node:sqlite` uses the embedded SQLite built from `deps/sqlite/sqlite.gyp`

Build the runtime:

```bash
./configure --prefix="$PWD/out-install"
make -j8 node
```

Verify the new binary directly:

```bash
./out/Release/node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
console.log("fts5: ok");
NODE
```

## Point lcm at that runtime

Put the FTS5-capable `node` first on `PATH` for whatever process starts the daemon — your shell
profile for a manual `lcm daemon start`, or the environment the hook's shell command inherits for
Claude Code or Codex. Then restart the daemon so it re-spawns under the new binary:

```bash
lcm daemon restart
```

## Verify

```bash
tail -n 60 ~/.lossless-claude/daemon.log
```

Confirm the daemon is up (`lcm status` reports its version and uptime), then run a search and
check `~/.lossless-claude/projects/<hash>/db.sqlite` fills as expected:

```bash
lcm search "some prior conversation"

sqlite3 ~/.lossless-claude/projects/<hash>/db.sqlite '
  select count(*) as conversations from conversations;
  select count(*) as messages from messages;
  select count(*) as summaries from summaries;
'
```
