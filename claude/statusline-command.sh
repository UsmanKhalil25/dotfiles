#!/bin/bash
input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')
remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
week_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
worktree=$(echo "$input" | jq -r '.workspace.git_worktree // empty')

home="$HOME"
short_cwd="${cwd/#$home/\~}"

branch=""
if git -C "$cwd" rev-parse --is-inside-work-tree --no-optional-locks >/dev/null 2>&1; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
fi

RESET=$'\033[0m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
CYAN=$'\033[36m'
SEP="${DIM} · ${RESET}"

# Build a 10-segment block bar for a given percentage (0–100).
# Usage: make_bar <percentage>
# Outputs: [████████░░]
make_bar() {
  local pct=$1
  local total=10
  local filled=$(( pct * total / 100 ))
  local empty=$(( total - filled ))
  local bar="["
  local i
  for (( i=0; i<filled; i++ )); do bar="${bar}█"; done
  for (( i=0; i<empty;  i++ )); do bar="${bar}░"; done
  bar="${bar}]"
  printf '%s' "$bar"
}

# Location block
loc="${BOLD}${short_cwd}${RESET}"
if [ -n "$worktree" ]; then
  loc="${loc} ${DIM}worktree:${worktree}${RESET}"
elif [ -n "$branch" ]; then
  loc="${loc} ${DIM}(${branch})${RESET}"
fi

# Model block
model_part=""
[ -n "$model" ] && model_part="${CYAN}${model}${RESET}"

# Context remaining — green >50%, yellow 20–50%, red <20%
ctx_part=""
if [ -n "$remaining" ]; then
  r=$(printf '%.0f' "$remaining")
  if [ "$r" -gt 50 ]; then c="$GREEN"
  elif [ "$r" -gt 20 ]; then c="$YELLOW"
  else c="$RED"; fi
  bar=$(make_bar "$r")
  ctx_part="${c}ctx ${bar} ${r}%${RESET}"
fi

# 5h usage — green <50%, yellow 50–80%, red >80%
five_part=""
if [ -n "$five_pct" ]; then
  v=$(printf '%.0f' "$five_pct")
  if [ "$v" -lt 50 ]; then c="$GREEN"
  elif [ "$v" -lt 80 ]; then c="$YELLOW"
  else c="$RED"; fi
  bar=$(make_bar "$v")
  five_part="${c}5h ${bar} ${v}%${RESET}"
fi

# 7d usage
week_part=""
if [ -n "$week_pct" ]; then
  v=$(printf '%.0f' "$week_pct")
  if [ "$v" -lt 50 ]; then c="$GREEN"
  elif [ "$v" -lt 80 ]; then c="$YELLOW"
  else c="$RED"; fi
  bar=$(make_bar "$v")
  week_part="${c}7d ${bar} ${v}%${RESET}"
fi

# Assemble — only include segments that have data
out="$loc"
[ -n "$model_part" ] && out="${out}${SEP}${model_part}"
[ -n "$ctx_part" ]   && out="${out}${SEP}${ctx_part}"
[ -n "$five_part" ]  && out="${out}${SEP}${five_part}"
[ -n "$week_part" ]  && out="${out}${SEP}${week_part}"

printf '%s' "$out"
