#!/usr/bin/env bash
# remote-web.sh — the app for a browser check, in one step: this folder's code on the test machine, its
# app and web server running there, and their ports on this machine's localhost. And one step to stop it.
#
# Usage: bash ~/.claude/scripts/remote/remote-web.sh start [--hold <minutes>] | stop | status
#   Per repository (the test machine runs Windows, as for remote-sync.sh):
#     git config sanad.remoteWebUp '<command run there: starts the web server and stays in the foreground>'
#     git config sanad.remoteWebPorts '<web port> [more ports]'   linked to localhost here; the first is the web server's
#     git config sanad.remoteAppRestart '<command run there>'      optional: the app picks up the synced code
#   start  1. stops the web server and the link an earlier start left — only its own, by the ids it saved
#          2. refuses a port another process holds (there or here): PORT-BUSY, ask the user
#          3. remote-sync.sh (this folder's exact code), the app restart, remote-preflight.sh (--app when
#             sanad.remoteAppUp is set, --db when sanad.remoteDbUp is set)
#          4. starts the web server there with the ports linked here, waits until the web port answers
#   stop   stops that web server and the link. Run it when the user reports the browser check.
#   status what a start left, and whether it still runs.
# Prints READY http://localhost:<port> … (exit 0), STOPPED, or NO-REMOTE (3), REMOTE-DOWN (4), PORT-BUSY (9),
# WEB-DOWN (10), FAILED (1); a failed sync or preflight keeps its own word and exit code.
# 2026-11-11 (TUW-242, TUW-243): every step was typed by hand. A link to an old web server held the ports
# here, the new server came up on another port behind it, and three web servers stayed on the test machine.
# Env: REMOTE_WEB_WAIT_SECONDS (default 90); REMOTE_WEB_SYNC, REMOTE_WEB_PREFLIGHT (tests: stand-ins).
set -uo pipefail

action="${1:-}"; [ "$#" -gt 0 ] && shift
hold=120
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hold) shift; hold="${1:-}" ;;
    *) echo "FAILED: unknown option $1 (usage: remote-web.sh start [--hold <minutes>] | stop | status)"; exit 1 ;;
  esac
  shift
done
case "$action" in start|stop|status) ;; *) echo "FAILED: usage: remote-web.sh start [--hold <minutes>] | stop | status"; exit 1 ;; esac
case "$hold" in ''|*[!0-9]*) echo "FAILED: --hold needs whole minutes"; exit 1 ;; esac
WAIT="${REMOTE_WEB_WAIT_SECONDS:-90}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state="${SANAD_STATE_DIR:-$HOME/.claude/state}"; mkdir -p "$state"

host=$(git config --get sanad.remoteHost || true)
[ -n "$host" ] || { echo "NO-REMOTE: no sanad.remoteHost is set; run the app here."; exit 3; }
case "$host" in *[!A-Za-z0-9_.-]*) echo "FAILED: sanad.remoteHost must be a plain host name"; exit 1 ;; esac
link_file="$state/remote-web-$host.link"      # this machine: "<pid> <windows pid or -> <ports>"
server_file="$state/remote-web-$host.server"  # the test machine: "<port> <pid>"
log="$state/remote-web-$host.log"
# This machine: the folder whose code the running app serves. remote-sync.sh refuses a sync from ANOTHER
# folder while that app is up (2026-11-12: a second task's sync changed the code under a browser check).
owner_file="$state/remote-web-$host.owner"

via=()
reach() { ssh -o BatchMode=yes -o ConnectTimeout=12 "$@" "$host" "echo ok" >/dev/null 2>&1; }
connect() {
  reach && return 0
  for a in $(git config --get-all sanad.remoteAddress 2>/dev/null); do
    if reach -o "HostName=$a"; then via=(-o "HostName=$a"); return 0; fi
  done
  return 1
}
on() { ssh -o BatchMode=yes -o ConnectTimeout=12 ${via[@]+"${via[@]}"} "$host" "$@" 2>/dev/null | tr -d '\r'; }

# The process that listens on a port of the test machine: its id, or nothing.
listener() { on "netstat -ano" | awk -v p=":$1" '$1 == "TCP" && $4 == "LISTENING" && substr($2, length($2) - length(p) + 1) == p { print $5; exit }'; }
image_of() { on "tasklist /fi \"PID eq $1\" /fo csv /nh" | awk -F'","' 'NR == 1 { gsub(/"/, "", $1); print $1 }'; }

# Is this local process still the link this script started? Its command line names ssh and the host.
is_link() {
  local words
  words=$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || ps -p "$1" -o command= 2>/dev/null || true)
  case "$words" in *ssh*"$host"*) return 0 ;; *) return 1 ;; esac
}
listening_here() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Stops what an earlier start left, and only that: the saved ids, checked again before each stop.
stop_own() {
  local stopped=""
  if [ -f "$link_file" ]; then
    read -r pid winpid _ < "$link_file" || true
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null && is_link "$pid"; then
      kill "$pid" 2>/dev/null || true
      stopped="the link here"
    elif [ -n "${winpid:-}" ] && [ "$winpid" != "-" ] && command -v tasklist >/dev/null 2>&1 &&
         tasklist //FI "PID eq $winpid" //FO CSV //NH 2>/dev/null | grep -qi '^"ssh'; then
      taskkill //PID "$winpid" //T //F >/dev/null 2>&1 || true
      stopped="the link here"
    fi
    rm -f "$link_file"
  fi
  if [ -f "$server_file" ]; then
    read -r port rpid < "$server_file" || true
    if [ -n "${rpid:-}" ] && [ "$(listener "$port")" = "$rpid" ]; then
      on "taskkill /PID $rpid /T /F" >/dev/null
      stopped="${stopped:+$stopped and }the web server on $host (pid $rpid, port $port)"
    fi
    rm -f "$server_file"
  fi
  rm -f "$owner_file"
  [ -n "$stopped" ] && echo "STOPPED: $stopped"
  return 0
}

if [ "$action" = status ]; then
  [ -f "$link_file" ] || [ -f "$server_file" ] || { echo "NOTHING: no web server or link from this script"; exit 0; }
  if [ -f "$link_file" ]; then read -r pid _ ports < "$link_file"; if kill -0 "$pid" 2>/dev/null && is_link "$pid"; then echo "LINK up (pid $pid, ports $ports)"; else echo "LINK gone (pid $pid)"; fi; fi
  if [ -f "$server_file" ]; then read -r port rpid < "$server_file"; connect || { echo "REMOTE-DOWN: $host does not answer"; exit 4; }
    if [ "$(listener "$port")" = "$rpid" ]; then echo "WEB up on $host (pid $rpid, port $port)"; else echo "WEB gone on $host (pid $rpid)"; fi; fi
  exit 0
fi

connect || { echo "REMOTE-DOWN: $host does not answer by name or by any sanad.remoteAddress. Ask the user before running the app on this machine."; exit 4; }

if [ "$action" = stop ]; then
  out=$(stop_own)
  if [ -n "$out" ]; then echo "$out"; else echo "NOTHING: no web server or link from this script to stop"; fi
  exit 0
fi

# ---- start ----
up=$(git config --get sanad.remoteWebUp || true); ports=$(git config --get sanad.remoteWebPorts || true)
[ -n "$up" ] && [ -n "$ports" ] || { echo "FAILED: start needs git config sanad.remoteWebUp (the command that starts the web server there) and sanad.remoteWebPorts (the web port first) in this repository"; exit 1; }
for p in $ports; do case "$p" in ''|*[!0-9]*) echo "FAILED: sanad.remoteWebPorts holds '$p'; it takes port numbers"; exit 1 ;; esac; done
web_port=${ports%% *}

stop_own
other=$(listener "$web_port")
if [ -n "$other" ]; then
  echo "PORT-BUSY: port $web_port on $host is held by pid $other ($(image_of "$other")), which this script did not start. Ask the user before stopping it."
  exit 9
fi
for p in $ports; do
  if listening_here "$p"; then echo "PORT-BUSY: port $p on this machine is in use, not by this script's link. Find it and ask the user before stopping it."; exit 9; fi
done

sync=$(bash "${REMOTE_WEB_SYNC:-$here/remote-sync.sh}" 2>&1); code=$?
synced=$(printf '%s\n' "$sync" | grep -m1 '^SYNCED ' || true)
[ "$code" = 0 ] && [ -n "$synced" ] || { printf '%s\n' "$sync" | grep -m1 . || echo "FAILED: the sync printed nothing"; exit $([ "$code" = 0 ] && echo 1 || echo "$code"); }

restart=$(git config --get sanad.remoteAppRestart || true)
if [ -n "$restart" ]; then on "$restart" >/dev/null; fi
flags=()
[ -n "$(git config --get sanad.remoteDbUp || true)" ] && flags+=(--db)
[ -n "$(git config --get sanad.remoteAppUp || true)" ] && flags+=(--app)
ready=""
if [ ${#flags[@]} -gt 0 ]; then
  pre=$(bash "${REMOTE_WEB_PREFLIGHT:-$here/remote-preflight.sh}" "${flags[@]}" --hold "$hold" 2>&1); code=$?
  ready=$(printf '%s\n' "$pre" | grep -m1 '^READY ' || true)
  [ "$code" = 0 ] && [ -n "$ready" ] || { printf '%s\n' "$pre" | grep -v '^NOTE:' | grep -m1 . || echo "FAILED: the preflight printed nothing"; exit $([ "$code" = 0 ] && echo 1 || echo "$code"); }
fi

forwards=()
for p in $ports; do forwards+=(-L "$p:127.0.0.1:$p"); done
: > "$log"
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 ${via[@]+"${via[@]}"} "${forwards[@]}" "$host" "$up" < /dev/null >> "$log" 2>&1 &
pid=$!
winpid=$(cat "/proc/$pid/winpid" 2>/dev/null || echo -)
echo "$pid $winpid $ports" > "$link_file"
git rev-parse --show-toplevel > "$owner_file" 2>/dev/null || rm -f "$owner_file"

answers() { [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:$web_port" 2>/dev/null)" -ge 200 ] 2>/dev/null; }
start=$SECONDS
until answers; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "WEB-DOWN: the web server on $host stopped before it answered. Its last lines:"; tail -5 "$log" | sed 's/^/  /'
    rm -f "$link_file"; exit 10
  fi
  if [ $((SECONDS - start)) -ge "$WAIT" ]; then
    echo "WEB-DOWN: http://localhost:$web_port did not answer within ${WAIT}s. Its last lines:"; tail -5 "$log" | sed 's/^/  /'
    kill "$pid" 2>/dev/null || true; rm -f "$link_file"
    rpid=$(listener "$web_port"); [ -n "$rpid" ] && on "taskkill /PID $rpid /T /F" >/dev/null
    exit 10
  fi
  sleep 1
done
rpid=$(listener "$web_port")
[ -n "$rpid" ] && echo "$web_port $rpid" > "$server_file"

echo "READY http://localhost:$web_port · ports $ports linked from $host · web server pid ${rpid:-unknown} there · code ${synced#SYNCED }"
[ -n "$ready" ] && echo "$ready"
echo "Stop it after the browser check: bash ~/.claude/scripts/remote/remote-web.sh stop"
