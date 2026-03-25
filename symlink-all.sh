#!/usr/bin/env bash
# Symlinks rrr skills into the global skill directories for:
#   - Claude Code  (~/.claude/skills/)
#   - pi-mono      (~/.pi/agent/skills/)
#   - codex        (~/.codex/skills/)
#   - opencode     (reads ~/.claude/skills/ automatically — covered above)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/.claude/skills"

SKILLS=(rrr rrr-auto)

TARGETS=(
  "$HOME/.claude/skills"       # Claude Code (also picked up by opencode)
  "$HOME/.pi/agent/skills"     # pi-mono
  "$HOME/.codex/skills"        # codex
)

symlink() {
  local src="$1"
  local dst="$2"

  mkdir -p "$(dirname "$dst")"

  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  (exists) $dst -> $src"
  else
    ln -sfn "$src" "$dst"
    echo "  (linked) $dst -> $src"
  fi
}

for target_dir in "${TARGETS[@]}"; do
  echo "$target_dir"
  for skill in "${SKILLS[@]}"; do
    symlink "$SKILLS_SRC/$skill" "$target_dir/$skill"
  done
done

echo ""
echo "Note: opencode reads ~/.claude/skills/ automatically — no extra symlinks needed."
