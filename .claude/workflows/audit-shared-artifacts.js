export const meta = {
  name: 'audit-shared-artifacts',
  description: 'Sweep every tracked text file for local-evidence rule violations and false documentation claims',
  whenToUse: 'Before a release, or after a burst of merged PRs, to catch machine-specific detail and stale claims that reached tracked files.',
  phases: [
    { title: 'Enumerate', detail: 'list tracked files from git and chunk them' },
    { title: 'Sweep', detail: 'one finder per chunk', model: 'haiku' },
    { title: 'Verify', detail: 'one adversary per finding', model: 'haiku' },
  ],
}

// Coverage comes from git, never from a list written by hand: a list you typed is a
// list you can forget, and the first run of this workflow missed test/, agents/ and
// .claude-plugin/ for exactly that reason — which is where its worst findings were.
const LINES_PER_CHUNK = 700
const MAX_CHUNKS = 24

const RULE = `
RULE A — "no local evidence in a shared artifact". From the project's standing instructions:

  "Never let session-local or account-local evidence into a shared artifact. What you
   observed (an error you hit, your quota, your machine, your config, the order you tried
   things) is how you learned the rule, not the rule. A changelog, commit message, comment
   or doc states what is true for any reader; if the claim only holds for this account or
   this run, it does not belong there at all."

And the project's related rule: a general-purpose tool never names a repository that merely
consumes it — not in a doc, comment, test, fixture, changeset or workflow.

VIOLATES rule A:
  - An absolute path inside somebody's home directory, or a bare personal username where a
    placeholder belongs.
  - A machine name, hostname, serial, device model, or LAN address specific to one machine.
  - An account-specific opaque id presented as general: a database directory hash, a session
    id, a project hash, an account id, a key fragment, one person's port number.
  - Quota, usage or cost numbers describing one person's plan or one run.
  - Narrative of the order things were tried: "first I tried", "it turned out", "I originally
    thought", "we discovered while debugging". The distilled rule belongs there; the journey
    does not.
  - A consumer repository named by this tool.

DOES NOT violate rule A — never report these:
  - A path that is part of the product's own contract, or any path using a placeholder.
  - This repository's own infrastructure documented as such: its own CI runner, its own
    workflows, its own package name, its own org and repo.
  - A path inside a string the program actually uses at runtime.
  - Obviously fake test fixtures, and example output marked as an example.
  - EVALUATION RESULTS ON A NAMED CORPUS THAT JUSTIFY A DESIGN DECISION. A comment or design
    note saying "this constant was chosen on N corpora, held out on M, and the curve is a
    broad plateau" is the rule stated with its evidence, not the journey. Deleting the
    numbers would leave a magic constant with nothing behind it. Exempt. Only report such a
    measurement when it leaks a machine path, an account id, or a consumer repo alongside it.

RULE B — "the documentation is true". A doc, README section or code comment stating something
the code contradicts:
  - Names a file, directory, function, script, npm script, CLI command, flag, env var, config
    key, table or column that does not exist or was renamed.
  - States a default, limit, path or behaviour that differs from the code.
  - Links to a file or heading that does not exist.
  - Describes a step as required or automatic when nothing performs it.
  - Contradicts another document in this repository.
  - Documents as present something that was removed.

Never report under rule B: typos, grammar, style, formatting, wording preferences, missing
documentation, or anything you would phrase as "could be clearer". Only claims that are FALSE.
`

const CHUNKS_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'every tracked text file, repo-relative, with its line count',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, lines: { type: 'integer' } },
        required: ['path', 'lines'],
      },
    },
    totalTracked: { type: 'integer', description: 'how many files git listed in total, before filtering' },
    excluded: { type: 'string', description: 'which extensions or paths you left out, and why' },
  },
  required: ['files', 'totalTracked', 'excluded'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          rule: { type: 'string', enum: ['A-local-evidence', 'B-doc-error'] },
          quote: { type: 'string', description: 'the offending text, verbatim' },
          why: { type: 'string', description: 'one sentence: what exactly is wrong' },
          evidence: { type: 'string', description: 'rule B: the file and line of the code that contradicts it. rule A: which category' },
          fix: { type: 'string', description: 'one sentence: the concrete edit' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['file', 'line', 'rule', 'quote', 'why', 'evidence', 'fix', 'severity'],
      },
    },
    filesRead: { type: 'integer', description: 'how many files you actually opened — an honest count' },
  },
  required: ['findings', 'filesRead'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    refutationReason: { type: 'string', description: 'if refuted, why. if not, the exact file and line you checked that confirms it' },
  },
  required: ['refuted', 'refutationReason'],
}

phase('Enumerate')

const inventory = await agent(
  `Run \`git ls-files\` in the current repository and return every tracked TEXT file with its line count.

Include: .md, .ts, .js, .mjs, .cjs, .sh, .yml, .yaml, .json, .txt, and extensionless files that are plain text.
Exclude: lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml), anything under dist/ or node_modules/, generated files whose header says they are generated, images, fonts and binaries.

Get line counts with \`wc -l\`. Report totalTracked as the raw count \`git ls-files | wc -l\` gave you, before any filtering, and say in "excluded" what you dropped and why. Do not sample, do not truncate: every tracked text file must appear.`,
  { label: 'enumerate', phase: 'Enumerate', schema: CHUNKS_SCHEMA },
)

if (!inventory || !inventory.files || inventory.files.length === 0) {
  log('ABORT: git listed no tracked text files — the enumeration is wrong, not the repository')
  return { error: 'enumeration returned nothing', confirmed: [] }
}

// Pack files into chunks by line count, so a finder gets a readable amount rather than
// a directory that happens to be huge.
const chunks = []
let current = { files: [], lines: 0 }
for (const file of [...inventory.files].sort((a, b) => a.path.localeCompare(b.path))) {
  if (current.lines > 0 && current.lines + file.lines > LINES_PER_CHUNK) {
    chunks.push(current)
    current = { files: [], lines: 0 }
  }
  current.files.push(file.path)
  current.lines += file.lines
}
if (current.files.length > 0) chunks.push(current)

const swept = chunks.slice(0, MAX_CHUNKS)
// Files past the cap are not audited. They are named in the result, not only in the log,
// so a capped run cannot be read as a complete one.
const unswept = chunks.slice(MAX_CHUNKS).flatMap((c) => c.files)
if (unswept.length > 0) {
  log(`CAP HIT: ${chunks.length} chunks needed, ${MAX_CHUNKS} swept. NOT swept (${unswept.length} files): ${unswept.join(', ')}`)
}

log(`${inventory.files.length} tracked text files of ${inventory.totalTracked} tracked, in ${swept.length} chunks. Excluded: ${inventory.excluded}`)

phase('Sweep')

const results = await pipeline(
  swept.map((chunk, index) => ({ index, files: chunk.files, lines: chunk.lines })),

  (chunk) => agent(
    `Audit these tracked files in the current repository. Read the real files; never guess.

YOUR SCOPE — every one of these, and nothing else (${chunk.files.length} files, about ${chunk.lines} lines):
${chunk.files.map((f) => `  ${f}`).join('\n')}

${RULE}

METHOD:
1. Open and read every file in your scope, completely. Do not skim, do not sample.
2. For rule A, also grep your scope for the telltale shapes: "/Users/", "/home/", "C:\\\\Users",
   a personal username, a long hex string presented as an id, "I tried", "I found",
   "originally", "turned out", "while debugging".
3. For rule B, every factual claim — a path, filename, function, npm script, CLI flag, env var,
   config key, default value, table or column — must be checked against the actual code or the
   actual file tree before you accept it. Use grep and file reads. A claim you did not check is
   not a finding; leave it out.
4. Report only what you verified, with exact line numbers.

Set filesRead to the number of files you actually opened. Report it honestly — a low count is
information, not a failure. An empty findings list is a fine answer and far better than a guess.`,
    { label: `sweep:${chunk.index}`, phase: 'Sweep', model: 'haiku', schema: FINDINGS_SCHEMA },
  ),

  // Verify per finding, not per chunk. One agent judging a batch drifts toward confirming
  // the batch; one agent per claim has nothing to agree with.
  (found, chunk) => {
    const findings = (found && found.findings) || []
    const read = (found && found.filesRead) || 0
    if (read < chunk.files.length) {
      log(`chunk ${chunk.index}: read ${read} of ${chunk.files.length} files — coverage of this chunk is partial`)
    }
    if (findings.length === 0) return []

    return parallel(findings.map((finding) => () =>
      agent(
        `You are the adversary. REFUTE the finding below, reported against a tracked file in the current repository. Assume it is wrong until the file proves otherwise.

${RULE}

THE FINDING:
${JSON.stringify(finding, null, 2)}

1. Open the named file at the named line. If the quoted text is not there, refute.
2. Rule A: check it against the "DOES NOT violate" list, especially the exemption for
   evaluation results that justify a design decision. Then ask: would this sentence still be
   true and useful for a reader on a different machine with a different account? If yes, refute.
3. Rule B: find the code yourself and confirm the contradiction. If the thing named DOES
   exist, or the behaviour IS what the code does, or you cannot reproduce the contradiction,
   refute.
4. Refute anything that is really a typo, a style preference, or "this could be clearer".

Default to refuted=true when you are not certain. A false finding wastes a person's time and
costs more here than a missed one. When you do NOT refute, name the exact file and line you
checked that confirms it.`,
        { label: `verify:${finding.file}:${finding.line}`, phase: 'Verify', model: 'haiku', schema: VERDICT_SCHEMA },
      ).then((verdict) => ({ ...finding, ...(verdict || { refuted: true, refutationReason: 'verifier returned nothing' }) })),
    ))
  },
)

const judged = results.filter(Boolean).flat().filter(Boolean)
const confirmed = judged.filter((v) => !v.refuted)
const refuted = judged.filter((v) => v.refuted)

const rank = { high: 0, medium: 1, low: 2 }
confirmed.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.file.localeCompare(b.file) || (a.line - b.line))

log(`${judged.length} findings judged, ${confirmed.length} survived, ${refuted.length} refuted`)

return {
  complete: unswept.length === 0,
  unswept,
  confirmed,
  counts: {
    trackedTextFiles: inventory.files.length,
    totalTracked: inventory.totalTracked,
    chunksSwept: swept.length,
    chunksNeeded: chunks.length,
    judged: judged.length,
    confirmed: confirmed.length,
    refuted: refuted.length,
    ruleA: confirmed.filter((v) => v.rule === 'A-local-evidence').length,
    ruleB: confirmed.filter((v) => v.rule === 'B-doc-error').length,
  },
  refutedSample: refuted.slice(0, 10).map((v) => ({ file: v.file, line: v.line, why: v.why, refutationReason: v.refutationReason })),
}
