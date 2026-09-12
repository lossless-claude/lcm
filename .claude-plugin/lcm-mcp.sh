#!/bin/sh
# Static launcher for the lcm MCP server, referenced by plugin.json.
#
# This file is tracked, so it must carry no machine-specific data. It resolves the
# node interpreter at runtime from lcm's per-machine config (~/.lossless-claude by
# default, or $LCM_HOME — mirrors src/lcm-home.ts), falling back to PATH when that
# config has no recorded path yet (e.g. before lcm has ever run). See
# docs/design/mcp-interpreter-resolution.md.
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
plugin_root="$(cd "$script_dir/.." && pwd)"
lcm_home="${LCM_HOME:-${HOME:-$(cd ~ && pwd)}/.lossless-claude}"
config_file="$lcm_home/config.json"

node_path=""
if [ -f "$config_file" ]; then
  node_path=$(grep -o '"mcpNodePath"[[:space:]]*:[[:space:]]*"[^"]*"' "$config_file" 2>/dev/null \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
fi

if [ -z "$node_path" ] || [ ! -x "$node_path" ]; then
  node_path=$(command -v node 2>/dev/null || true)
fi

if [ -z "$node_path" ]; then
  echo "lcm-mcp.sh: no node interpreter found (checked $config_file and PATH)" >&2
  exit 1
fi

exec "$node_path" "$plugin_root/mcp.mjs"
