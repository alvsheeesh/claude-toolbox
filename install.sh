#!/usr/bin/env bash
# Installs the toolbox in this machine's Claude Code (user scope, every session).
# Usage: ./install.sh                 -> everything
#        ./install.sh auto-model ...  -> only the plugins you name
set -euo pipefail

REPO="${CLAUDE_TOOLBOX_REPO:-alvsheeesh/claude-toolbox}"
ALL=(prompt-upgrade auto-model clean-view toolbox burn-meter superpowers)
PLUGINS=("${@:-${ALL[@]}}")

command -v claude >/dev/null || { echo "Claude Code is not installed (no 'claude' on PATH)." >&2; exit 1; }

if ! claude plugin marketplace list 2>/dev/null | grep -q "claude-toolbox"; then
  claude plugin marketplace add "$REPO"
else
  claude plugin marketplace update claude-toolbox || true
fi

for p in "${PLUGINS[@]}"; do
  echo "Installing $p..."
  claude plugin install "$p@claude-toolbox" || echo "  $p could not be installed, skipping." >&2
done

echo "Done. Start a new Claude Code session (or run /reload-plugins) to load them."
