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

mkdir -p "$PI_AGENT_DIR"

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

packages=(
  'npm:pi-web-access@0.22.0'
  'npm:pi-agent-modes@0.3.0'
  'npm:@pi-extensions/pi-statusline@0.2.0'
)

for package in "${packages[@]}"; do
  printf 'Installing %s...\n' "$package"
  pi install "$package"
done

printf '\nPi setup is ready. Authenticate providers inside Pi with /login.\n'
