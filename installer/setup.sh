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
      echo "  ANTHROPIC_API_KEY is not set in your environment."
      echo "  Please export ANTHROPIC_API_KEY before running lcm, for example:"
      echo "    export ANTHROPIC_API_KEY=your_api_key_here"
    else
      echo "  ▸ Using ANTHROPIC_API_KEY from environment"
    fi
    # Write env-var placeholder — config.ts expands \${VAR} at runtime
    API_KEY='${ANTHROPIC_API_KEY}'
    echo ""
  fi

  if [ "$PROVIDER" = "openai" ]; then
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "  OPENAI_API_KEY is not set in your environment."
      echo "  Please export OPENAI_API_KEY before running lcm, for example:"
      echo "    export OPENAI_API_KEY=your_api_key_here"
    else
      echo "  ▸ Using OPENAI_API_KEY from environment"
    fi
    # Write env-var placeholder — config.ts expands \${VAR} at runtime
    API_KEY='${OPENAI_API_KEY}'

    read -r -p "  Base URL [https://api.openai.com/v1]: " BASE_URL_INPUT
    BASE_URL="${BASE_URL_INPUT:-https://api.openai.com/v1}"
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

// Load existing config (preserve non-llm keys)
let existing = {};
if (fs.existsSync(configFile)) {
  try { existing = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
}

const llm = { provider };
if (model)   llm.model   = model;
if (apiKey)  llm.apiKey  = apiKey;
if (baseURL) llm.baseURL = baseURL;

const config = { ...existing, llm };
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
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
