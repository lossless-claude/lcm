#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${LOSSLESS_CLAUDE_DIR:-${HOME}/.lossless-claude/plugin}"
NPM_PREFIX="${HOME}/.npm-global"

echo ""
echo "  lcm — installer"
echo ""

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  ▸ Updating existing clone at ${INSTALL_DIR}"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "  ▸ Cloning to ${INSTALL_DIR}"
  git clone https://github.com/lossless-claude/lcm.git "$INSTALL_DIR"
fi

# Build
echo "  ▸ Building"
cd "$INSTALL_DIR"
npm install --silent
npm run build
if [ ! -f "${INSTALL_DIR}/dist/bin/lcm.js" ]; then
  echo "  ✘ Build failed — dist/bin/lcm.js not found" >&2
  exit 1
fi

# Install binary as a wrapper script (avoids npm prefix/permission issues)
# rm -f first: a previous run may have left a symlink here pointing back into dist/,
# and `cat >` follows symlinks — it would overwrite the compiled JS instead of the wrapper.
echo "  ▸ Installing lcm binary to ${NPM_PREFIX}/bin"
mkdir -p "${NPM_PREFIX}/bin"
rm -f "${NPM_PREFIX}/bin/lcm"
cat > "${NPM_PREFIX}/bin/lcm" << WRAPEOF
#!/bin/sh
exec node "${INSTALL_DIR}/dist/bin/lcm.js" "\$@"
WRAPEOF
chmod +x "${NPM_PREFIX}/bin/lcm"

# Make binary available for the rest of this script
export PATH="${NPM_PREFIX}/bin:${PATH}"

# Persist to the active shell's profile if not already there
if [[ "${SHELL}" == */zsh ]]; then
  _RC="${HOME}/.zshrc"
elif [[ "${SHELL}" == */bash ]]; then
  _RC="${HOME}/.bash_profile"
else
  _RC="${HOME}/.profile"
fi
if ! grep -q '# lcm' "${_RC}" 2>/dev/null; then
  echo "" >> "${_RC}"
  echo '# lcm' >> "${_RC}"
  printf 'export PATH="%s/bin:${PATH}"\n' "${NPM_PREFIX}" >> "${_RC}"
  echo "  ▸ Added ${NPM_PREFIX}/bin to PATH in ${_RC}"
fi

# Run the full installer (wires up hooks, daemon, Cipher, runs doctor)
lcm install

echo ""
echo "  Reload your shell to use lcm in new terminals:"
echo "    source ${_RC}"
echo ""
