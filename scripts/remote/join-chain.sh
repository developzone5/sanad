#!/usr/bin/env bash
# join-chain.sh — merge a chain of PR branches upward on the remote, without an agent session.
#
# Usage: bash ~/.claude/scripts/remote/join-chain.sh <ssh-host> <list-file>
#   <list-file>  one join per line, tab-separated, lowest first: <remote-worktree> <lower-branch> <upper-branch>
# Each upper branch must be checked out in its worktree. Commit identity is that worktree's git config.
# The head before the merge is kept in refs/before-join/<upper>, so a re-check can read a PR's own fixes.
# Stops at the first conflict: prints CONFLICT and the files, and leaves the merge open for one session
# to finish. Run it again with the joins still to do.
# The remote shell is assumed to be Windows cmd.
set -uo pipefail

HOST="${1:?ssh host}"; LIST="${2:?list file}"
run() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$1"; }

# The list is read on fd 3, so no command inside the loop can swallow the remaining lines.
while IFS=$'\t' read -r wt lower upper <&3; do
  [ -z "${wt:-}" ] && continue
  head="$(run "git -C \"$wt\" symbolic-ref --short HEAD" | tr -d '\r')"
  [ "$head" = "$upper" ] || { echo "STOP: $wt is on '${head:-unknown}', not $upper"; exit 1; }
  run "git -C \"$wt\" update-ref refs/before-join/$upper $upper" || { echo "STOP: could not save the head of $upper"; exit 1; }
  run "git -C \"$wt\" merge --no-ff -m \"Merge branch '$lower' into $upper\" $lower" >/dev/null
  rc=$?
  if [ "$rc" = 255 ]; then echo "STOP: connection lost at $lower into $upper; check it before running again"; exit 1; fi
  if [ "$rc" != 0 ]; then
    echo "CONFLICT $lower into $upper in $wt"
    run "git -C \"$wt\" diff --name-only --diff-filter=U"
    exit 1
  fi
  echo "ok $lower into $upper"
done 3< "$LIST"
echo "JOIN DONE"
