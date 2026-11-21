#!/usr/bin/env bash
# remote-preflight.sh — make the remote test machine ready before the task needs it, in one step.
#
# Usage: bash ~/.claude/scripts/remote/remote-preflight.sh --connect | [--db] [--app] [--hold <minutes>]
#   --connect checks SSH only.
#   Reaches sanad.remoteHost by name, then by each sanad.remoteAddress; opens the desktop container
#   app through the "Sanad Docker Desktop" task when its engine does not answer; with --db, starts the
#   database and waits until it is healthy. Per repository:
#     git config sanad.remoteDbUp '<command run there that starts the database>'
#     git config sanad.remoteDbContainer <container name>
#     git config sanad.remoteDbHeal '<command run there after a failed start>' (optional)
#   --app does the same for the app (sanad.remoteAppUp, sanad.remoteAppContainer), so a browser check at
#   the end of the task finds it running (2026-11-09: starting it at the end cost about 1.5 minutes).
#   The matching Heal key (sanad.remoteAppHeal for the app) runs once. A successful heal allows one retry.
#   --db or --app also writes a hold (default 120 minutes) that the idle-stop task honours, so the database is
#   not stopped between two test runs of the same task.
# Prints READY <host> ssh, or READY <host> docker <version>[ db <container> <state>][ app <container> <state>]
# (exit 0), or
# NO-REMOTE (3), REMOTE-DOWN (4: ask the user before running here), DOCKER-DOWN (6), DB-DOWN (7),
# APP-DOWN (8), FAILED (1).
# 2026-11-09 (TUW-238): the task stopped four times for the remote: its name did not resolve, the
# container app was closed, and the idle-stop stopped MySQL twice between two test runs.
# Env: PREFLIGHT_WAIT_SECONDS (240), PREFLIGHT_STEP_SECONDS (10), PREFLIGHT_HEAL_SECONDS (30).
set -uo pipefail

connect_only=0; db=0; app=0; hold=120
while [ "$#" -gt 0 ]; do
  case "$1" in
    --connect) connect_only=1 ;;
    --db) db=1 ;;
    --app) app=1 ;;
    --hold) shift; hold="${1:-}" ;;
    *) echo "FAILED: unknown option $1 (usage: remote-preflight.sh --connect | [--db] [--app] [--hold <minutes>])"; exit 1 ;;
  esac
  shift
done
case "$hold" in ''|*[!0-9]*) echo "FAILED: --hold needs whole minutes"; exit 1 ;; esac
if [ "$connect_only" = 1 ] && { [ "$db" = 1 ] || [ "$app" = 1 ]; }; then
  echo "FAILED: --connect cannot be used with --db or --app"; exit 1
fi
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
if [ "$connect_only" = 1 ]; then echo "READY $host ssh"; exit 0; fi

remote_ssh=(ssh -o BatchMode=yes -o ConnectTimeout=12 ${via[@]+"${via[@]}"} "$host")
on() { "${remote_ssh[@]}" "$@" 2>/dev/null | tr -d '\r'; }

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

if [ "$db" = 0 ] && [ "$app" = 0 ]; then echo "READY $host docker $version"; exit 0; fi

# Each service to bring up: label, its two git config keys, and the exit code when it does not come up.
services=()
[ "$db" = 1 ] && services+=("db:remoteDb:7:DB-DOWN")
[ "$app" = 1 ] && services+=("app:remoteApp:8:APP-DOWN")
for s in "${services[@]}"; do
  IFS=: read -r label key _ _ <<<"$s"
  up=$(git config --get "sanad.${key}Up" || true); name=$(git config --get "sanad.${key}Container" || true)
  [ -n "$up" ] && [ -n "$name" ] || { echo "FAILED: --$label needs git config sanad.${key}Up and sanad.${key}Container in this repository"; exit 1; }
  case "$name" in *[!A-Za-z0-9_.-]*) echo "FAILED: sanad.${key}Container must be a plain container name"; exit 1 ;; esac
done

# The hold first, so the idle-stop does not stop what is starting.
until=$(date -u -d "+${hold} minutes" +%Y-%m-%dT%H:%M:%SZ)
on "echo ${until}> %USERPROFILE%\.claude\docker-hold.txt" >/dev/null

inspect_service() {
  local snapshot
  snapshot=$(on "docker inspect -f \"{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}\" $name" | head -1)
  read -r status restarts health <<< "$snapshot"
  st=""
  case "$status:$health" in running:healthy) st=healthy ;; running:-) st=running ;; esac
}

state_text() {
  printf '%s' "${status:-missing}"
  case "$health" in ''|-) ;; *) printf ' (health %s)' "$health" ;; esac
}

container_logs() {
  "${remote_ssh[@]}" "docker logs --tail 20 $name" 2>&1 | tr -d '\r' | tail -20 | sed 's/^/  /'
}

start_service() {
  local start previous=$restarts stalled=0
  on "$up" >/dev/null
  start=$SECONDS
  while :; do
    inspect_service
    if [[ "$restarts" =~ ^[0-9]+$ ]]; then
      if [[ "$previous" =~ ^[0-9]+$ ]] && [ "$restarts" -gt "$previous" ]; then
        failure="$(state_text); restart count grew from $previous to $restarts"
        return 1
      fi
      previous=$restarts
    fi
    [ -z "$st" ] || return 0
    case "$status" in exited|dead|restarting) stalled=$((stalled + 1)) ;; *) stalled=0 ;; esac
    if [ "$stalled" -ge 2 ]; then failure="$(state_text) on two polls"; return 1; fi
    if [ $((SECONDS - start)) -ge "$MAX" ]; then failure="$(state_text) after ${MAX}s"; return 1; fi
    sleep "$STEP"
  done
}

heal_service() {
  local heal_key="sanad.${key}Heal" heal heal_max="${PREFLIGHT_HEAL_SECONDS:-30}" heal_code
  heal=$(git config --local --get "$heal_key" 2>/dev/null || true)
  [ -n "$heal" ] || return 1
  if ! [[ "$heal_max" =~ ^[1-9][0-9]*$ ]]; then
    failure="$failure; PREFLIGHT_HEAL_SECONDS needs positive whole seconds"
    return 1
  fi
  echo "NOTE: $name on $host is $failure. Its last lines:"
  container_logs
  echo "NOTE: running $heal_key once for $name on $host"
  timeout -k 2 -- "$heal_max" "${remote_ssh[@]}" "$heal" >/dev/null 2>&1
  heal_code=$?
  case "$heal_code" in
    0) inspect_service; start_service ;;
    124|137) failure="$failure; heal timed out after ${heal_max}s"; return 1 ;;
    *) failure="$failure; heal failed (exit $heal_code)"; return 1 ;;
  esac
}

line="READY $host docker $version"
for s in "${services[@]}"; do
  IFS=: read -r label key code word <<<"$s"
  up=$(git config --get "sanad.${key}Up"); name=$(git config --get "sanad.${key}Container")
  inspect_service
  if [ -z "$st" ]; then
    echo "NOTE: $name is $(state_text); starting it"
    if ! start_service && ! heal_service; then
      echo "$word: $name on $host is $failure. Its last lines:"
      container_logs
      exit "$code"
    fi
  fi
  line="$line $label $name $st"
done
echo "$line (held until $until)"
