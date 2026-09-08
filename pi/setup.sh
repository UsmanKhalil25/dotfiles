#!/usr/bin/env bash
set -euo pipefail

PI_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$PI_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
BACKUP_STAMP="$(date +%Y%m%d%H%M%S)"

if ! command -v pi >/dev/null 2>&1; then
  printf '%s\n' 'Pi is not installed or is not available on PATH.' >&2
  printf '%s\n' 'Install Pi first, then rerun ./pi/setup.sh.' >&2
  exit 1
fi

mkdir -p "$PI_AGENT_DIR" "$PI_AGENT_DIR/extensions" "$PI_AGENT_DIR/agents"

copy_config() {
  local source="$1"
  local destination="$2"

  if [ -e "$destination" ] || [ -L "$destination" ]; then
    if cmp -s "$source" "$destination"; then
      return
    fi

    local backup="${destination}.backup.${BACKUP_STAMP}"
    cp "$destination" "$backup"
    printf 'Backed up %s to %s\n' "$destination" "$backup"
  fi

  cp "$source" "$destination"
  printf 'Installed %s\n' "$destination"
}

copy_config "$REPO_ROOT/pi/agent/settings.json" "$PI_AGENT_DIR/settings.json"
copy_config "$REPO_ROOT/pi/agent/modes.config.json" "$PI_AGENT_DIR/modes.config.json"
copy_config "$REPO_ROOT/pi/agent/statusline.json" "$PI_AGENT_DIR/statusline.json"
copy_config "$REPO_ROOT/pi/agent/APPEND_SYSTEM.md" "$PI_AGENT_DIR/APPEND_SYSTEM.md"
copy_config "$REPO_ROOT/pi/agent/plan-artifacts.json" "$PI_AGENT_DIR/plan-artifacts.json"
copy_config "$REPO_ROOT/pi/agent/extensions/plan-artifacts.ts" "$PI_AGENT_DIR/extensions/plan-artifacts.ts"
copy_config "$REPO_ROOT/pi/agent/plan-artifacts-lib.ts" "$PI_AGENT_DIR/plan-artifacts-lib.ts"
# Remove the helper's old auto-discovered location from earlier revisions.
if [ -f "$PI_AGENT_DIR/extensions/plan-artifacts-lib.ts" ]; then
  rm "$PI_AGENT_DIR/extensions/plan-artifacts-lib.ts"
fi
copy_config "$REPO_ROOT/pi/agent/agents/plan-worker.md" "$PI_AGENT_DIR/agents/plan-worker.md"

packages=(
  'npm:pi-web-access@0.22.0'
  'npm:pi-agent-modes@0.3.0'
  'npm:@pi-extensions/pi-statusline@0.1.3'
  'npm:pi-subagents@0.49.0'
)

for package in "${packages[@]}"; do
  printf 'Installing %s...\n' "$package"
  pi install "$package"
done

printf '\nPi setup is ready. Authenticate providers inside Pi with /login.\n'
