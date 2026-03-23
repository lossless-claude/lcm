#!/usr/bin/env bash
set -euo pipefail

# lossless-claude setup script
# Configures the LLM provider for compaction/summarization and installs hooks.

CONFIG_DIR="$HOME/.lossless-claude"
CONFIG_FILE="$CONFIG_DIR/config.json"

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
  # Non-interactive / CI mode: fall through silently with defaults.
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
  echo "    4) anthropic      — Anthropic API (needs ANTHROPIC_API_KEY)"
  echo "    5) openai         — OpenAI-compatible API (needs OPENAI_API_KEY)"
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
    MODEL="gpt-4o-mini"
  fi

  # ── API key / baseURL prompts (provider-specific) ──

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
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "  ERROR: OPENAI_API_KEY is not set in your environment."
      echo ""
      echo "  Export it first, then re-run setup:"
      echo "    export OPENAI_API_KEY=your_api_key_here"
      echo ""
      exit 1
    fi
    echo "  ▸ Using OPENAI_API_KEY from environment"
    # Write env-var placeholder — config.ts expands \${VAR} at runtime
    API_KEY='${OPENAI_API_KEY}'

    read -r -p "  Base URL [https://api.openai.com/v1]: " BASE_URL_INPUT
    # Trim leading/trailing whitespace from user input
    BASE_URL="$(echo "${BASE_URL_INPUT:-https://api.openai.com/v1}" | xargs)"
    echo "  ▸ Base URL: ${BASE_URL}"
    echo ""
  fi
fi

# ── Write config.json ──
# Uses node for proper JSON encoding and merges into any existing config file
# so that non-llm keys (security, daemon settings, etc.) are preserved.

mkdir -p "$CONFIG_DIR"

node - "$PROVIDER" "$MODEL" "$API_KEY" "$BASE_URL" "$CONFIG_FILE" <<'NODE'
const fs = require('fs');
const [provider, model, apiKey, baseURL, configFile] = process.argv.slice(2);

// Load existing config (preserve non-llm keys).
// Fail loudly if the file exists but contains invalid JSON to avoid data loss.
let existing = {};
if (fs.existsSync(configFile)) {
  let raw;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
    existing = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: Failed to parse existing config at ${configFile}.`);
    console.error('The file contains invalid JSON. Fix or remove it, then re-run setup.');
    process.exit(1);
  }
}

const llm = { provider };
if (model)   llm.model   = model;
if (apiKey)  llm.apiKey  = apiKey;
if (baseURL) llm.baseURL = baseURL;

// Merge: preserve all existing top-level keys, overwrite only the llm block.
const config = { ...existing, llm };
const out = JSON.stringify(config, null, 2) + '\n';
fs.writeFileSync(configFile, out, { mode: 0o600 });
// Explicitly tighten permissions even if the file already existed.
fs.chmodSync(configFile, 0o600);
NODE

if [ -t 0 ]; then
  echo "  ▸ Config written to ${CONFIG_FILE}"
  echo ""
fi

# ── Install hooks ──

if [ -t 0 ]; then echo "  ──── Installing hooks"; echo ""; fi
lcm install
if [ -t 0 ]; then echo ""; fi

# ── Verify ──

if [ -t 0 ]; then echo "  ──── Running lcm doctor"; echo ""; fi
lcm doctor
if [ -t 0 ]; then echo ""; fi

if [ -t 0 ]; then echo "  Setup complete."; echo ""; fi

exit 0
