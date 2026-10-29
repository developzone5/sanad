#!/usr/bin/env bash
# guard-helpers.sh — restart remote helpers that a network drop stopped mid-work.
#
# Usage: bash ~/.claude/scripts/remote/guard-helpers.sh <environment> <list-file>
#   <list-file>  one helper per line, tab-separated: <handle> <role> <remote-worktree> <remote-brief> [report-file-name]
#                A line whose report file exists on the remote is finished and is skipped.
# Every GUARD_INTERVAL_SECONDS (default 120) it reads each helper's terminal. A helper that stopped on a
# connection error (API error, ENOTFOUND, connection reset, socket hang up) is relaunched through
# orca-launch.sh with a note to continue from its saved work; the list file then holds the new handle.
# Ends when every line's report exists, or after GUARD_MAX_SECONDS (default 14400).
set -uo pipefail

ENVN="${1:?environment}"; LIST="${2:?list file}"
L="$HOME/.claude/scripts/remote/orca-launch.sh"
H_SSH="${ORCA_SSH_HOST:-$ENVN}"
STEP="${GUARD_INTERVAL_SECONDS:-120}"; MAX="${GUARD_MAX_SECONDS:-14400}"; start=$SECONDS
NOTE='You were restarted after a network drop. Your commits and the uncommitted changes in git status are your work in progress: continue from them, never discard them, and finish the brief.'

report_exists() { # remote brief path, report name
  local dir="${1%[\\/]*}"
  # -n: never read the caller's stdin (the loop reads the list file there).
  ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$H_SSH" "if exist \"$dir\\$2\" (exit 0) else (exit 1)" >/dev/null 2>&1
}
while :; do
  open=0; tmp="$(mktemp)"
  # The list is read on fd 3, so no command inside the loop can swallow the remaining lines.
  while IFS=$'\t' read -r handle role wt brief report <&3; do
    [ -z "${handle:-}" ] && continue
    if [ -n "${report:-}" ] && report_exists "$brief" "$report"; then printf '%s\t%s\t%s\t%s\t%s\n' "$handle" "$role" "$wt" "$brief" "$report" >> "$tmp"; continue; fi
    open=$((open + 1))
    tail_text="$(timeout 30 orca terminal read --environment "$ENVN" --terminal "$handle" 2>/dev/null | tr -d '\r' | grep -v '^\s*$' | tail -4)"
    if echo "$tail_text" | grep -qiE 'API Error|ENOTFOUND|ECONNRESET|socket hang up|Connection (reset|lost)'; then
      if echo "$tail_text" | grep -qE '(done|for [0-9]+m [0-9]+s) ?[0-9: APM]*$|· done '; then
        echo "$(date +%H:%M) $handle stopped on a connection error; restarting"
        timeout 20 orca terminal close --environment "$ENVN" --terminal "$handle" >/dev/null 2>&1
        out="$(bash "$L" --role "$role" "$ENVN" "$wt" "$brief" "$NOTE" 2>&1)"; echo "  $out"
        new="$(echo "$out" | grep -o 'term_[a-z0-9-]*' | head -1)"; [ -n "$new" ] && handle="$new"
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$handle" "$role" "$wt" "$brief" "${report:-}" >> "$tmp"
  done 3< "$LIST"
  mv "$tmp" "$LIST"
  [ "$open" = 0 ] && { echo "$(date +%H:%M) every helper has reported"; exit 0; }
  [ $((SECONDS - start)) -ge "$MAX" ] && { echo "TIMEOUT: $open helper(s) still open"; exit 1; }
  sleep "$STEP"
done
