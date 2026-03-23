#!/usr/bin/env bash
set -euo pipefail

# lossless-claude setup script
# Configures the LLM provider for compaction/summarization and installs hooks.

CONFIG_DIR="$HOME/.lossless-claude"
CONFIG_FILE="$CONFIG_DIR/config.json"

# ── Dry-run support (used by installer/dry-run-deps.ts) ──

if [ "${XGH_DRY_RUN:-}" = "1" ]; then
  echo ""
  echo "  [dry-run] lossless-claude setup would:"
  echo "    1. Prompt for LLM provider selection (auto / claude-process / codex-process / anthropic / openai / disabled)"
  echo "    2. Write ~/.lossless-claude/config.json with the chosen llm block"
  echo "    3. Run: lcm install"
  echo "    4. Run: lcm doctor"
  echo ""
  exit 0
fi

# ── Preflight: require lcm ──

if ! command -v lcm &>/dev/null; then
  echo ""
  echo "  ERROR: lcm is not installed."
  echo ""
  echo "    Install it with:  npm install -g @lossless-claude/lcm"
  echo ""
  exit 1
fi

# ── Provider Selection ──

PROVIDER="auto"
MODEL=""
API_KEY=""
BASE_URL=""

if [ ! -t 0 ]; then
  # Non-interactive / CI mode: skip prompts and fall through using defaults.
  true
else
  echo ""
  echo "  lossless-claude setup"
  echo ""
  echo "  Which LLM provider should lcm use for compaction/summarization?"
  echo ""
  echo "    1) auto           — uses claude-process (or codex-process for Codex clients) [recommended]"
  echo "    2) claude-process — Claude Code CLI subprocess (no API key needed)"
  echo "    3) codex-process  — Codex CLI subprocess (no API key needed)"
  echo "    4) anthropic      — Anthropic API (requires ANTHROPIC_API_KEY env var)"
  echo "    5) openai         — OpenAI-compatible API (uses OPENAI_API_KEY when required by the server)"
  echo "    6) disabled       — no LLM, import-only mode (no compaction)"
  echo ""

  read -r -p "  Pick [1]: " PROVIDER_CHOICE
  PROVIDER_CHOICE="${PROVIDER_CHOICE:-1}"

  case "$PROVIDER_CHOICE" in
    1) PROVIDER="auto" ;;
    2) PROVIDER="claude-process" ;;
    3) PROVIDER="codex-process" ;;
    4) PROVIDER="anthropic" ;;
    5) PROVIDER="openai" ;;
    6) PROVIDER="disabled" ;;
    *)
      echo "  Invalid choice — defaulting to auto"
      PROVIDER="auto"
      ;;
  esac

  echo "  ▸ Using provider: ${PROVIDER}"
  echo ""

  # ── Model defaults (provider-specific) ──

  if [ "$PROVIDER" = "anthropic" ]; then
    MODEL="claude-haiku-4-5-20251001"
  elif [ "$PROVIDER" = "openai" ]; then
    read -r -p "  Model ID [gpt-4o-mini]: " MODEL_INPUT
    MODEL="${MODEL_INPUT:-gpt-4o-mini}"
    echo "  \u25b8 Model: ${MODEL}"
    echo ""
  fi

  # ── API key / baseURL prompts (provider-specific) ──
  # API keys are read from the environment only (never stored as plaintext).
  # config.ts expands ${VAR} placeholders in llm.apiKey at runtime.

  if [ "$PROVIDER" = "anthropic" ]; then
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      echo "  ERROR: ANTHROPIC_API_KEY is not set in your environment."
      echo ""
      echo "  Export it first, then re-run setup:"
      echo "    export ANTHROPIC_API_KEY=your_api_key_here"
      echo ""
      exit 1
    fi
    echo "  ▸ Using ANTHROPIC_API_KEY from environment"
    # Write env-var placeholder — config.ts expands \${VAR} at runtime
    API_KEY='${ANTHROPIC_API_KEY}'
    echo ""
  fi

  if [ "$PROVIDER" = "openai" ]; then
    if [ -n "${OPENAI_API_KEY:-}" ]; then
      echo "  ▸ Using OPENAI_API_KEY from environment"
      # Write env-var placeholder — config.ts expands \${VAR} at runtime
      API_KEY='${OPENAI_API_KEY}'
    else
      echo "  ▸ OPENAI_API_KEY is not set; proceeding without an API key."
      echo "    (This is acceptable for some OpenAI-compatible local servers.)"
    fi

    read -r -p "  Base URL [https://api.openai.com/v1]: " BASE_URL_INPUT
    # Trim leading/trailing whitespace using pure bash parameter expansion
    BASE_URL_INPUT="${BASE_URL_INPUT:-https://api.openai.com/v1}"
    BASE_URL="${BASE_URL_INPUT#"${BASE_URL_INPUT%%[![:space:]]*}"}"
    BASE_URL="${BASE_URL%"${BASE_URL##*[![:space:]]}"}"
    echo "  \u25b8 Base URL: ${BASE_URL}"
    echo ""

    # Fail fast: public OpenAI API requires a key
    if [ -z "${API_KEY:-}" ] && [ "$BASE_URL" = "https://api.openai.com/v1" ]; then
      echo "  ERROR: OPENAI_API_KEY is required when using the public OpenAI API."
      echo ""
      echo "  Export it first, then re-run setup:"
      echo "    export OPENAI_API_KEY=your_api_key_here"
      echo ""
      exit 1
    fi
  fi
fi

# ── Write config.json ──
# Uses node for proper JSON encoding.
# Merges into any existing config file: replaces only the "llm" block in-place
# if it already exists (preserving key order/formatting), otherwise appends it
# or creates a new file. Existing non-llm keys are always preserved.

mkdir -p "$CONFIG_DIR"

node - "$PROVIDER" "$MODEL" "$API_KEY" "$BASE_URL" "$CONFIG_FILE" <<'NODE'
const fs = require('fs');
const [provider, model, apiKey, baseURL, configFile] = process.argv.slice(2);

const llm = { provider };
if (model)   llm.model   = model;
if (apiKey)  llm.apiKey  = apiKey;
if (baseURL) llm.baseURL = baseURL;

// If config doesn't exist, write a fresh file.
if (!fs.existsSync(configFile)) {
  const out = JSON.stringify({ llm }, null, 2) + '\n';
  fs.writeFileSync(configFile, out, { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
  process.exit(0);
}

// Load existing config. Fail loudly on parse errors to prevent data loss.
let raw;
try {
  raw = fs.readFileSync(configFile, 'utf8');
  JSON.parse(raw); // validate
} catch (err) {
  console.error(`Error: Failed to parse existing config at ${configFile}.`);
  console.error('The file contains invalid JSON. Fix or remove it, then re-run setup.');
  process.exit(1);
}

const llmJson = JSON.stringify(llm, null, 2);
const llmBlock = `"llm": ${llmJson}`;

// Try in-place replacement of the existing "llm" key to preserve formatting.
// The regex matches the "llm" key with any JSON value (object, null, string, etc.)
// to prevent duplicate keys when the existing value is not a plain object.
// Falls back to insert-before-last-brace when no existing key is found.
const llmRegex = /"llm"\s*:\s*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}|"(?:[^"\\]|\\.)*"|null|true|false|-?\d[\d.eE+\-]*)/s;
let newRaw;
if (llmRegex.test(raw)) {
  newRaw = raw.replace(llmRegex, llmBlock);
} else {
  // No existing llm block — insert before the last closing brace.
  // Parse first to assert the top-level is a plain object (not an array etc.)
  // to prevent corrupting files with unusual-but-valid JSON structure.
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('Error: ' + configFile + ' is not a JSON object. Cannot merge llm block.');
    process.exit(1);
  }
  const lastBrace = raw.lastIndexOf('}');
  if (lastBrace === -1) {
    newRaw = JSON.stringify({ ...parsed, llm }, null, 2) + '\n';
  } else {
    const before = raw.slice(0, lastBrace).replace(/\s*$/, '');
    const needsComma = before !== '{' && !/,\s*$/.test(before);
    newRaw = before + (needsComma ? ',\n  ' : '\n  ') + llmBlock + '\n' + raw.slice(lastBrace);
  }
}

if (!newRaw.endsWith('\n')) newRaw += '\n';
fs.writeFileSync(configFile, newRaw, { mode: 0o600 });
// Explicitly tighten permissions even if the file already existed.
fs.chmodSync(configFile, 0o600);
NODE

if [ -t 0 ]; then
  echo "  ▸ Config written to ${CONFIG_FILE}"
  echo ""
fi

# ── Install hooks ──

if [ -t 0 ]; then echo "  ──── Installing hooks"; echo ""; fi
if [ -t 0 ]; then
  lcm install
else
  lcm install >/dev/null 2>&1
fi
if [ -t 0 ]; then echo ""; fi

# ── Verify ──

if [ -t 0 ]; then echo "  ──── Running lcm doctor"; echo ""; fi
if [ -t 0 ]; then
  lcm doctor
else
  lcm doctor >/dev/null 2>&1
fi
if [ -t 0 ]; then echo ""; fi

if [ -t 0 ]; then echo "  Setup complete."; echo ""; fi

exit 0
