# Security & Privacy Design

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Secrets scrubbing pipeline, `lcm sensitive` CLI, and transparency documentation

---

## Problem

lossless-claude is lossless by design — it stores every message in SQLite and sends conversation chunks to the Claude LLM for summarization. This creates two risk surfaces:

1. **Storage** — secrets (API keys, tokens, passwords) written to SQLite persist indefinitely
2. **LLM exposure** — secrets sent to Claude for summarization leave the local machine

There is currently no user-facing mechanism to define what is sensitive, no documented data retention policy, and no tooling to purge stored data. Users operating in regulated or sensitive environments have no way to verify what lcm stores or to opt out of storing specific content.

---

## Goals

- Scrub known and user-defined secrets before any SQLite write or LLM call
- Give users CLI tooling to manage sensitive patterns without touching hashed directories
- Publish a clear, accurate privacy policy as part of the project documentation
- Surface security status in `lcm doctor`

## Non-Goals

- Encryption at rest (out of scope for this iteration)
- Automatic secret detection via ML/entropy analysis
- GDPR compliance tooling (export, right-to-erasure workflows)

---

## Architecture

### 1. ScrubEngine (`src/scrub.ts`)

A pure, stateless module that merges pattern sources and applies redaction.

**Pattern sources (merged in order):**

| Source | Path | Scope |
|---|---|---|
| Built-in defaults | hardcoded in `src/scrub.ts` | All projects |
| Global user patterns | `sensitivePatterns: string[]` in `~/.lossless-claude/config.json` | All projects |
| Per-project patterns | `~/.lossless-claude/projects/{hash}/sensitive-patterns.txt` | Current project only |

**Built-in default patterns:**

```
/sk-[A-Za-z0-9]{20,}/              # OpenAI keys (sk-...)
/sk-ant-[A-Za-z0-9\-]{40,}/        # Anthropic keys (sk-ant-api03-...)
/ghp_[A-Za-z0-9]{36}/              # GitHub personal access tokens
/AKIA[0-9A-Z]{16}/                 # AWS access key IDs
/-----BEGIN .* KEY-----/            # PEM private key headers (body not matched — known v1 limitation)
/Bearer [A-Za-z0-9\-._~+/]+=*/     # Bearer tokens
/[Pp]assword\s*[:=]\s*\S+/         # Inline password assignments (env-style PASSWORD= not matched — known v1 limitation)
```

**Replacement:** matched content → `[REDACTED]`

**Integration points:**

- `POST /ingest` — scrub message content before `createMessagesBulk()`
- `createCompactHandler()` inline ingest — the compact route calls `createMessagesBulk()` directly (independent of the ingest handler); must scrub here too
- `CompactionEngine.compact()` — scrub chunk text before sending to LLM
- No scrubbing of already-stored data (retroactive scrubbing is a separate future feature)

**`sensitive-patterns.txt` format:**

```
# One pattern per line. Lines starting with # are comments.
# Patterns are plain regex strings (no /.../ delimiters). Flags are NOT supported.
# Applied as: new RegExp(line) — JavaScript RegExp, case-sensitive, no flags.
# Inline flag syntax like (?i) is NOT supported by JavaScript RegExp.
# For case-insensitive matches, encode the desired cases in the pattern itself
# (e.g., [Mm][Yy]_[Tt][Oo][Kk][Ee][Nn]) or use a character class.
MY_INTERNAL_TOKEN_[A-Z0-9]+
internal\.corp\.example\.com
```

The same no-delimiter format applies to `sensitivePatterns` in `config.json` and to built-in patterns in `src/scrub.ts`. The `/pattern/` notation shown in the built-in patterns table is documentation shorthand only — the actual values stored are plain strings.

### 2. `lcm sensitive` CLI subcommand

Manages patterns without requiring users to find or edit hashed paths directly.

```
lcm sensitive list                  # print all active patterns (global + project, with source label)
lcm sensitive add "<pattern>"       # append to current project's sensitive-patterns.txt
lcm sensitive add --global "<pat>"  # append to config.json sensitivePatterns array
lcm sensitive remove "<pattern>"    # remove from project patterns (exact match)
lcm sensitive test "<string>"       # dry-run: show which patterns match and what gets redacted
lcm sensitive purge                 # delete ~/.lossless-claude/projects/{hash}/ (current project)
lcm sensitive purge --all           # delete all of ~/.lossless-claude/projects/
```

`lcm sensitive list` output format:

```
Global patterns (config.json):
  [built-in]  /sk-[A-Za-z0-9]{20,}/
  [user]      MY_ORG_TOKEN_.*

Project patterns (~/.lossless-claude/projects/abc123/sensitive-patterns.txt):
  [user]      INTERNAL_API_KEY_.*
```

### 3. `lcm doctor` integration

Add a security check to the doctor output:

```
── Security ─────────────────────────────────
    ✅  built-in patterns   6 active
    ⚠️   project patterns   none configured
         Run: lcm sensitive add "<pattern>" to protect project-specific secrets
```

The warning is non-fatal — lcm still operates without project patterns.

### 4. DaemonConfig schema update

```typescript
// src/daemon/config.ts
interface SecurityConfig {
  sensitivePatterns: string[]; // user-defined global regexes
}

interface DaemonConfig {
  // existing fields...
  security: SecurityConfig;
}
```

Default: `security: { sensitivePatterns: [] }`

---

## Documentation

### `docs/privacy.md`

Full data handling policy covering:

- **What is stored:** conversation messages, tool outputs, LLM summaries — all in `~/.lossless-claude/projects/{hash}/db.sqlite`
- **What leaves the machine:** chunks sent to Claude LLM for summarization. The default summarizer (`claude-process`) uses the local `claude` CLI subprocess — no separate network call is made by lcm. If an optional OpenAI or Anthropic provider is configured in `config.json`, conversation chunks are sent to that provider's API over the network. lcm makes no outbound connections of its own beyond the configured LLM provider.
- **What is never stored externally:** raw messages, tool results, file contents — only summaries persist beyond the LLM call
- **Scrubbing:** built-in patterns + user-defined patterns applied before storage and before LLM calls
- **Retention:** no automatic expiry; user controls deletion via `lcm sensitive purge`
- **Opting out:** `lcm uninstall` removes all hooks; `lcm sensitive purge --all` deletes all stored data

### README update

A short **Privacy** section (3–4 sentences) linking to `docs/privacy.md` with the key assurance:

> "Conversation data is stored locally in `~/.lossless-claude/`. By default, only conversation chunks are sent to Claude (the same model powering Claude Code) for summarization — no other outbound connections are made by lcm itself. If you configure an optional OpenAI or Anthropic provider, chunks are sent to that provider's API. Built-in redaction scrubs common secret patterns before storage or summarization. See [docs/privacy.md](docs/privacy.md) for the full policy and instructions to add custom patterns."

---

## Testing

| Test | What it verifies |
|---|---|
| `ScrubEngine` unit tests | Built-in patterns match known secret formats |
| Custom pattern loading | Per-project file parsed correctly; `#` comments ignored |
| Merge order | Global patterns always precede project patterns |
| Ingest integration | Secrets redacted before SQLite write |
| Compact integration | Secrets redacted before LLM chunk |
| `lcm sensitive add` | Appends to correct file, idempotent on duplicate |
| `lcm sensitive test` | Correct dry-run output for matching and non-matching input |
| `lcm sensitive purge` | Deletes project dir; `--all` deletes all projects |
| `lcm sensitive remove` | Exact-match removal; no match → clear error message |
| Compact handler ingest | Inline `createMessagesBulk()` in compact route also scrubs |
| Invalid regex in doctor | Malformed pattern in `sensitive-patterns.txt` surfaces as warning in `lcm doctor` |

---

## Open Questions

1. Should retroactive scrubbing of existing stored data be a v1 feature or deferred?
   → **Defer.** Complex and destructive. Document limitation in `docs/privacy.md`.

2. Should `lcm sensitive purge` require confirmation (`--yes` flag)?
   → **Yes.** Destructive operation — require `--yes` or interactive prompt.

3. Should invalid regex patterns in `sensitive-patterns.txt` fail silently or block ingest?
   → **Warn and skip.** Log invalid pattern, continue with remaining patterns. Surface in `lcm doctor`.
