import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { CommitStore, type CommitCandidate, type CommitReference } from "./store/commit-store.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { yieldToEventLoop } from "./daemon/project-queue.js";
import { WorkerStore } from "./store/worker-store.js";

const execute = promisify(execFile);
const HASH = /^[a-f0-9]{7,64}$/i;
const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_BYTES = 1024 * 1024;
type Context = { store: CommitStore; conversations: ConversationStore; workers: WorkerStore; cwd: string };

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execute("git", ["--no-replace-objects", ...args], {
      cwd, encoding: "utf8", timeout: GIT_READ_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_BYTES,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
        GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    });
    return stdout.trimEnd();
  } catch (error) {
    // A timeout or unavailable executable cannot establish that an object is gone.
    if (typeof (error as { code?: unknown }).code !== "number") throw new Error("Local git reference read failed");
    return null;
  }
}

async function resolve(cwd: string, hash: string): Promise<Pick<CommitReference, "hash" | "subject" | "authorAt" | "resolved">> {
  const full = HASH.test(hash) ? await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${hash}^{commit}`]) : null;
  const metadata = full && HASH.test(full) ? await git(cwd, ["show", "--no-patch", "--format=%s%n%aI", full, "--"]) : null;
  const [subject, date] = metadata?.split("\n") ?? [];
  return date && Number.isFinite(Date.parse(date))
    ? { hash: full!, subject, authorAt: new Date(date).toISOString(), resolved: true }
    : { hash, subject: null, authorAt: null, resolved: false };
}

function outputs(content: string): Array<{ hash: string; branch: string | null }> {
  const found: Array<{ hash: string; branch: string | null }> = [];
  // Normal, root and detached-HEAD commit output, plus git log/show's commit header.
  const pattern = /\[(.+?)[ \t]+([a-f0-9]{7,64})\]|^commit\s+([a-f0-9]{40}|[a-f0-9]{64})(?:\s|$)|^([a-f0-9]{7,64})\s+.+$|^([a-f0-9]{40}|[a-f0-9]{64})$/gim;
  for (const match of content.matchAll(pattern)) found.push({ hash: match[2] ?? match[3] ?? match[4] ?? match[5],
    branch: match[1] ? (match[1].includes("detached HEAD") ? null : match[1].replace(/ \(root-commit\)$/, "")) : null });
  return found;
}

async function outputReference(context: Context, message: CommitCandidate, found: { hash: string; branch: string | null }): Promise<CommitReference> {
  const prior = context.store.find({ messageId: message.message_id, evidence: "commit-output", evidenceValue: found.hash });
  const metadata = prior && !prior.resolved ? prior : await resolve(context.cwd, prior?.hash ?? found.hash);
  return { ...metadata, sessionId: message.session_id, messageId: message.message_id, branch: prior?.branch ?? found.branch,
    evidence: "commit-output", evidenceValue: found.hash };
}

const TRAILER_PAGE_SIZE = 128;
async function* trailerHashes(cwd: string, url: string): AsyncGenerator<string> {
  for (let offset = 0; ; offset += TRAILER_PAGE_SIZE) {
    const history = await git(cwd, ["log", "--all", "--fixed-strings", "--all-match", "--grep=Claude-Session:", `--grep=${url}`,
      `--skip=${offset}`, `--max-count=${TRAILER_PAGE_SIZE}`, "--format=%H", "--"]);
    const hashes = history ? history.split("\n").filter(hash => HASH.test(hash)) : [];
    yield* hashes;
    await yieldToEventLoop();
    if (hashes.length < TRAILER_PAGE_SIZE) return;
  }
}

async function trailerReference(context: Context, message: CommitCandidate, evidence: { url: string; hash: string }): Promise<CommitReference | null> {
  const { url, hash } = evidence;
  const prior = context.store.find({ messageId: message.message_id, evidence: "session-trailer", evidenceValue: url, hash });
  if (prior && !prior.resolved) return null;
  const trailers = await git(context.cwd, ["show", "--no-patch", "--format=%(trailers:key=Claude-Session,valueonly)", hash, "--"]);
  if (!trailers?.split("\n").some(value => value.trim() === url)) return null;
  return { ...await resolve(context.cwd, hash), sessionId: message.session_id, messageId: message.message_id,
    branch: null, evidence: "session-trailer", evidenceValue: url };
}

async function* urlReferences(context: Context, message: CommitCandidate, url: string): AsyncGenerator<CommitReference> {
  for await (const hash of trailerHashes(context.cwd, url)) {
    const ref = await trailerReference(context, message, { url, hash });
    if (ref) yield ref;
  }
}

async function* trailerReferences(context: Context, message: CommitCandidate): AsyncGenerator<CommitReference> {
  const urls = new Set(`${message.content}\n${message.tool_output ?? ""}`.match(/https:\/\/claude\.ai\/code\/session_[a-zA-Z0-9_-]+/g) ?? []);
  for (const url of urls) yield* urlReferences(context, message, url);
}

async function* messageReferences(context: Context, message: CommitCandidate): AsyncGenerator<CommitReference> {
  const output = `${message.role === "tool" ? message.content : ""}\n${message.tool_output ?? ""}`;
  for (const found of outputs(output)) yield await outputReference(context, message, found);
  yield* trailerReferences(context, message);
}

async function refreshReference(context: Context, ref: CommitReference): Promise<void> {
  if (!ref.resolved) return;
  if (!(await resolve(context.cwd, ref.hash)).resolved) await context.conversations.withTransaction(() => context.store.markUnresolved(ref));
}

async function repairCandidate(context: Context, message: CommitCandidate): Promise<{ updated: number; candidates: number; references: number }> {
  const report = { updated: 0, candidates: 0, references: 0 };
  if (context.workers.excluded(message.session_id)) return report;
  report.candidates++;
  for await (const ref of messageReferences(context, message)) {
    report.updated += await context.conversations.withTransaction(() => context.store.record(ref));
    report.references++;
  }
  return report;
}

/** The caller owns the project queue and mutation lease; each page commits before yielding. */
export async function backfillProjectCommits(db: DatabaseSync, cwd: string, enabled = true): Promise<{ updated: number; candidates: number; references: number }> {
  const report = { updated: 0, candidates: 0, references: 0 };
  if (!enabled) return report;
  const context = { store: new CommitStore(db), conversations: new ConversationStore(db), workers: new WorkerStore(db), cwd };
  for await (const page of context.store.referencePages()) {
    for (const ref of page) await refreshReference(context, ref);
  }
  for await (const page of context.store.candidatePages()) {
    for (const message of page) {
      const repaired = await repairCandidate(context, message);
      report.updated += repaired.updated;
      report.candidates += repaired.candidates;
      report.references += repaired.references;
    }
    await yieldToEventLoop();
  }
  await new SummaryStore(db).recomputeProjectTimeBounds();
  return report;
}
