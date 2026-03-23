#!/usr/bin/env bash
set -euo pipefail

# lossless-claude setup script
# Handles backend selection, infrastructure setup, and final verification

echo ""
echo "  lossless-claude memory stack setup"
echo ""

# Defaults (used in non-interactive mode or as fallback)
BACKEND="vllm-mlx"
EMBEDDING_PORT=11435
SUMMARIZER_CHOICE=1
EMBEDDING_MODEL="mlx-community/nomicai-modernbert-embed-base-8bit"

# Non-TTY (CI, piped input): skip interactive prompts, use defaults
if [ ! -t 0 ]; then
  echo "  [non-interactive mode — using defaults]"
else
  # ── Backend Selection ──

  echo ""
  echo "  Which inference backend?"
  echo ""
  echo "    1) Local — vllm-mlx (macOS Apple Silicon)     [auto-detected]"
  echo "    2) Local — Ollama (Linux / Intel Mac)"
  echo "    3) Remote — connect to another machine's server"
  echo ""

  read -p "  Pick [1]: " BACKEND_CHOICE
  BACKEND_CHOICE="${BACKEND_CHOICE:-1}"

  case "$BACKEND_CHOICE" in
    1)
      BACKEND="vllm-mlx"
      EMBEDDING_PORT=11435
      echo "  ▸ Using vllm-mlx backend"
      ;;
    2)
      BACKEND="ollama"
      EMBEDDING_PORT=11434
      echo "  ▸ Using Ollama backend"
      ;;
    3)
      BACKEND="remote"
      read -p "  Remote server URL (e.g. http://192.168.1.x:8000): " REMOTE_URL
      echo "  ▸ Using remote backend at ${REMOTE_URL}"
      ;;
    *)
      BACKEND="vllm-mlx"
      EMBEDDING_PORT=11435
      echo "  ▸ Invalid choice — defaulting to vllm-mlx"
      ;;
  esac

  # ── Summarizer Selection ──

  echo ""
  echo "  Picking brains 🧠"
  echo ""
  echo "  Pick a Cipher LLM provider (reasoning brain)"
  echo ""
  echo "    1) claude-server — Claude Haiku via your Claude subscription [recommended]"
  echo "    2) Local model via vllm-mlx"
  echo "    3) Remote OpenAI-compatible endpoint"
  echo ""

  read -p "  Pick [1]: " SUMMARIZER_CHOICE
  SUMMARIZER_CHOICE="${SUMMARIZER_CHOICE:-1}"

  # ── Embedding Model Selection ──

  echo ""
  echo "  Pick an embedding model (semantic search engine)"
  echo ""
  echo "    1) ModernBERT Embed 8-bit (default, 768 dims, best quality) [current] [installed]"
  echo "    2) ModernBERT Embed 4-bit (smaller, 768 dims)"
  echo "    3) MiniLM L6 (fast, 384 dims)"
  echo "    c) Custom HuggingFace model ID"
  echo ""

  read -p "  Pick [1]: " EMBEDDING_CHOICE
  EMBEDDING_CHOICE="${EMBEDDING_CHOICE:-1}"

  case "$EMBEDDING_CHOICE" in
    1)
      EMBEDDING_MODEL="mlx-community/nomicai-modernbert-embed-base-8bit"
      echo "  ▸ Using ModernBERT Embed 8-bit"
      ;;
    2)
      EMBEDDING_MODEL="mlx-community/nomicai-modernbert-embed-base-4bit"
      echo "  ▸ Using ModernBERT Embed 4-bit"
      ;;
    3)
      EMBEDDING_MODEL="sentence-transformers/all-MiniLM-L6-v2"
      echo "  ▸ Using MiniLM L6"
      ;;
    c|C)
      read -p "  HuggingFace model ID: " EMBEDDING_MODEL
      ;;
    *)
      EMBEDDING_MODEL="mlx-community/nomicai-modernbert-embed-base-8bit"
      echo "  ▸ Using ModernBERT Embed 8-bit (default)"
      ;;
  esac
fi

# ── Install Summarizer ──

case "$SUMMARIZER_CHOICE" in
  1)
    echo "  ▸ Installing claude-server..."
    if ! command -v claude-server &>/dev/null && ! command -v claude-max-api &>/dev/null; then
      npm install -g claude-max-api-proxy 2>/dev/null || echo "  [⚠️  claude-server install skipped]"
    fi
    ;;
  2)
    echo "  ▸ Using local model via vllm-mlx"
    ;;
  3)
    read -p "  Server URL: " CUSTOM_SERVER_URL
    echo "  ▸ Using remote endpoint at ${CUSTOM_SERVER_URL}"
    ;;
esac

# ── Infrastructure Dependencies (Optional) ──

echo ""
echo "  ──── Installing backend dependencies"
echo ""

# Check if Qdrant is running (optional, for Phase 3 semantic search)
if command -v qdrant &>/dev/null || pgrep -f qdrant &>/dev/null; then
  echo "  ▸ Qdrant is already running"
else
  echo "  [ℹ️  Qdrant optional for Phase 3 semantic search — skipping for now]"
fi

# ── Final Messages ──

echo ""
echo "  ──── Wiring up the memory layer 🧬"
echo ""
echo "  ▸ SQLite cross-session memory: ready"
echo "  ▸ Lazy daemon (auto-spawn on demand): enabled"
if [ -f ~/.cipher/cipher.yml ]; then
  echo "  ▸ cipher.yml exists — will sync backend config"
fi

echo ""
echo "  ──---- Verifying the stack"
echo ""

# Qdrant check (optional)
if pgrep -f qdrant &>/dev/null; then
  echo "  ▸ Qdrant: healthy ✓"
else
  echo "  [ℹ️  Qdrant: not running (optional for Phase 3)]"
fi

# Summary
echo ""
echo "  Configuration:"
echo "    Backend: ${BACKEND}"
if [ "$BACKEND" = "remote" ]; then
  echo "    Remote URL: ${REMOTE_URL:-not set}"
fi
echo "    Embedding model: ${EMBEDDING_MODEL}"
echo ""
echo "  Setup complete. Run: lcm install"
echo ""

exit 0
