#!/usr/bin/env bash
# wait-files.sh — wait until every named file exists on a remote Windows host.
#
# Usage: bash ~/.claude/scripts/remote/wait-files.sh <ssh-host> <remote-file> [<remote-file> ...]
# Prints READY when all files exist (exit 0), TIMEOUT after WAIT_MAX_SECONDS (default 10800, exit 1).
# A lost connection is reported once per outage and the wait goes on.
# Env: WAIT_INTERVAL_SECONDS (default 45).
set -uo pipefail

HOST="${1:?ssh host}"; shift
[ "$#" -ge 1 ] || { echo "usage: wait-files.sh <ssh-host> <remote-file>..."; exit 2; }
MAX="${WAIT_MAX_SECONDS:-10800}"; STEP="${WAIT_INTERVAL_SECONDS:-45}"
start=$SECONDS; down=0

while :; do
  missing=0; lost=0
  for f in "$@"; do
    ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "if exist \"$f\" (exit 0) else (exit 1)" >/dev/null 2>&1
    case $? in
      0) ;;
      1) missing=$((missing + 1)) ;;
      *) lost=1; break ;;
    esac
  done
  if [ "$lost" = 1 ]; then
    [ "$down" = 0 ] && echo "CONNECTION LOST to $HOST; still waiting"
    down=1
  else
    [ "$down" = 1 ] && echo "CONNECTION BACK to $HOST"
    down=0
    [ "$missing" = 0 ] && { echo "READY ($# file(s) on $HOST)"; exit 0; }
  fi
  if [ $((SECONDS - start)) -ge "$MAX" ]; then
    if [ "$down" = 1 ]; then echo "TIMEOUT after ${MAX}s (connection to $HOST still lost)"; else echo "TIMEOUT after ${MAX}s ($missing file(s) still missing)"; fi
    exit 1
  fi
  sleep "$STEP"
done
