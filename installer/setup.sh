#!/usr/bin/env bash
set -euo pipefail

# lossless-claude setup script
# Configures the LLM provider for compaction/summarization and installs hooks.

CONFIG_DIR="$HOME/.lossless-claude"
CONFIG_FILE="$CONFIG_DIR/config.json"

echo ""
echo "  lossless-claude setup"
echo ""

# ── Preflight: require lcm ──

if ! command -v lcm &>/dev/null; then
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
  echo "  [non-interactive mode — using defaults: provider=auto]"
else
  echo "  Which LLM provider should lcm use for compaction/summarization?"
  echo ""
  echo "    1) auto          — tries claude-process, codex-process, anthropic, openai in order [recommended]"
  echo "    2) claude-process — Claude Code CLI subprocess (no API key needed)"
  echo "    3) codex-process  — Codex CLI subprocess (no API key needed)"
  echo "    4) anthropic      — Anthropic API (needs ANTHROPIC_API_KEY)"
  echo "    5) openai         — OpenAI-compatible API (needs OPENAI_API_KEY)"
  echo "    6) disabled       — no LLM, import-only mode (no compaction)"
  echo ""

  read -p "  Pick [1]: " PROVIDER_CHOICE
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

  # ── API key / baseURL prompts (provider-specific) ──

  if [ "$PROVIDER" = "anthropic" ]; then
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      read -p "  ANTHROPIC_API_KEY: " API_KEY
    else
      API_KEY="$ANTHROPIC_API_KEY"
      echo "  ▸ Using ANTHROPIC_API_KEY from environment"
    fi
  fi

  if [ "$PROVIDER" = "openai" ]; then
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      read -p "  OPENAI_API_KEY: " API_KEY
    else
      API_KEY="$OPENAI_API_KEY"
      echo "  ▸ Using OPENAI_API_KEY from environment"
    fi

    read -p "  Base URL [https://api.openai.com/v1]: " BASE_URL_INPUT
    BASE_URL="${BASE_URL_INPUT:-https://api.openai.com/v1}"
    echo "  ▸ Base URL: ${BASE_URL}"
    echo ""
  fi
fi

# ── Write config.json ──

mkdir -p "$CONFIG_DIR"

# Build JSON — only include non-empty optional fields
API_KEY_JSON=""
if [ -n "$API_KEY" ]; then
  # Escape the key for JSON (basic safety — API keys should not contain quotes)
  API_KEY_JSON=", \"apiKey\": \"${API_KEY}\""
fi

BASE_URL_JSON=""
if [ -n "$BASE_URL" ]; then
  BASE_URL_JSON=", \"baseURL\": \"${BASE_URL}\""
fi

cat > "$CONFIG_FILE" <<EOF
{
  "llm": {
    "provider": "${PROVIDER}",
    "model": "${MODEL}"${API_KEY_JSON}${BASE_URL_JSON}
  }
}
EOF

echo "  ▸ Config written to ${CONFIG_FILE}"
echo ""

# ── Install hooks ──

echo "  ──── Installing hooks"
echo ""
lcm install
echo ""

# ── Verify ──

echo "  ──── Running lcm doctor"
echo ""
lcm doctor
echo ""

echo "  Setup complete."
echo ""

exit 0
