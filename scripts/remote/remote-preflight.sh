#!/usr/bin/env bash
# remote-preflight.sh — make the remote test machine ready before the task needs it, in one step.
#
# Usage: bash ~/.claude/scripts/remote/remote-preflight.sh [--db] [--hold <minutes>]
#   Reaches sanad.remoteHost by name, then by each sanad.remoteAddress; opens the desktop container
#   app through the "Sanad Docker Desktop" task when its engine does not answer; with --db, starts the
#   database and waits until it is healthy. Per repository:
#     git config sanad.remoteDbUp '<command run there that starts the database>'
#     git config sanad.remoteDbContainer <container name>
#   --db also writes a hold (default 120 minutes) that the idle-stop task honours, so the database is
#   not stopped between two test runs of the same task.
# Prints READY <host> docker <version>[ db <container> <state>] (exit 0), or NO-REMOTE (3),
# REMOTE-DOWN (4: ask the user before running here), DOCKER-DOWN (6), DB-DOWN (7), FAILED (1).
# 2026-11-09 (TUW-238): the task stopped four times for the remote: its name did not resolve, the
# container app was closed, and the idle-stop stopped MySQL twice between two test runs.
# Env: PREFLIGHT_WAIT_SECONDS (default 240), PREFLIGHT_STEP_SECONDS (default 10).
set -uo pipefail

db=0; hold=120
while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) db=1 ;;
    --hold) shift; hold="${1:-}" ;;
    *) echo "FAILED: unknown option $1 (usage: remote-preflight.sh [--db] [--hold <minutes>])"; exit 1 ;;
  esac
  shift
done
case "$hold" in ''|*[!0-9]*) echo "FAILED: --hold needs whole minutes"; exit 1 ;; esac
MAX="${PREFLIGHT_WAIT_SECONDS:-240}"; STEP="${PREFLIGHT_STEP_SECONDS:-10}"

host=$(git config --get sanad.remoteHost || true)
[ -n "$host" ] || { echo "NO-REMOTE: no sanad.remoteHost is set; run locally."; exit 3; }

via=()
reach() { ssh -o BatchMode=yes -o ConnectTimeout=12 "$@" "$host" "echo ok" >/dev/null 2>&1; }
if ! reach; then
  found=""
  for a in $(git config --get-all sanad.remoteAddress 2>/dev/null); do
    if reach -o "HostName=$a"; then found=$a; break; fi
  done
  [ -n "$found" ] || { echo "REMOTE-DOWN: $host does not answer by name or by any sanad.remoteAddress. Ask the user before running on this machine."; exit 4; }
  via=(-o "HostName=$found")
  echo "NOTE: $host answered at $found, not by its name"
fi
on() { ssh -o BatchMode=yes -o ConnectTimeout=12 ${via[@]+"${via[@]}"} "$host" "$@" 2>/dev/null | tr -d '\r'; }

# Waits until `$1` (a function) prints a ready word, or the time is up.
wait_for() {
  local start=$SECONDS
  while :; do
    out=$("$1")
    [ -n "$out" ] && { echo "$out"; return 0; }
    [ $((SECONDS - start)) -ge "$MAX" ] && return 1
    sleep "$STEP"
  done
}

engine() { on 'docker info --format "{{.ServerVersion}}"' | grep -E '^[0-9]+\.' | head -1; }
version=$(engine)
if [ -z "$version" ]; then
  echo "NOTE: the container engine on $host is not running; opening it"
  on 'schtasks /run /tn "Sanad Docker Desktop"' >/dev/null
  version=$(wait_for engine) || { echo "DOCKER-DOWN: the container engine on $host did not start within ${MAX}s. Ask the user to open it there."; exit 6; }
fi

if [ "$db" = 0 ]; then echo "READY $host docker $version"; exit 0; fi

up=$(git config --get sanad.remoteDbUp || true)
name=$(git config --get sanad.remoteDbContainer || true)
[ -n "$up" ] && [ -n "$name" ] || { echo "FAILED: --db needs git config sanad.remoteDbUp and sanad.remoteDbContainer in this repository"; exit 1; }
case "$name" in *[!A-Za-z0-9_.-]*) echo "FAILED: sanad.remoteDbContainer must be a plain container name"; exit 1 ;; esac

# The hold first, so the idle-stop does not stop the database while it starts.
until=$(date -u -d "+${hold} minutes" +%Y-%m-%dT%H:%M:%SZ)
on "echo ${until}> %USERPROFILE%\\.claude\\docker-hold.txt" >/dev/null

state() { on "docker inspect -f \"{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}\" $name" | head -1; }
ready() { s=$(state); case "$s" in healthy) echo healthy ;; running) on "docker inspect -f \"{{if .State.Health}}x{{end}}\" $name" | grep -q x || echo running ;; esac; }
s=$(ready)
if [ -z "$s" ]; then
  echo "NOTE: $name is $(state || true); starting it"
  on "$up" >/dev/null
  s=$(wait_for ready) || { echo "DB-DOWN: $name on $host is $(state || echo missing) after ${MAX}s. Read its log there: docker logs --tail 50 $name"; exit 7; }
fi
echo "READY $host docker $version db $name $s (held until $until)"
