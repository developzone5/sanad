#!/usr/bin/env bash
# remote-sync.sh — put exactly the code of this folder on the remote test machine, without a push.
#
# Usage: bash ~/.claude/scripts/remote/remote-sync.sh
#   Optional setting (none set = run everything locally, as before):
#     git config --global sanad.remoteHost <ssh-alias>      the remote test machine
#     git config sanad.remoteRepo <path-on-remote>          this repository's clone there (per repo)
#     git config --global --add sanad.remoteAddress <ip>   tried when the alias's name does not answer
#   The commit here plus every uncommitted, not-ignored change goes over as a git bundle (your index
#   and branch are untouched). The remote clone, which must be clean, checks out that exact tree
#   (detached). Then run builds and tests there as a plain command, judged by its output:
#     ssh <alias> "cd /d <path-on-remote>\<subfolder> && <command>"
# Prints SYNCED <alias>:<path> <commit> tree <tree> (exit 0), or NO-REMOTE (3: run locally),
# REMOTE-DOWN (4: ask the user before running locally), REMOTE-DIRTY (5), FAILED (1).
# 2026-11-06: the user's desktop ran a full suite at a third of its speed with timeouts; the user's
# rule is "the remote machine first, ask before using this one".
set -uo pipefail

host=$(git config --get sanad.remoteHost || true)
[ -n "$host" ] || { echo "NO-REMOTE: no sanad.remoteHost is set; run locally."; exit 3; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "FAILED: not inside a git repository"; exit 1; }
rrepo=$(git -C "$top" config --get sanad.remoteRepo || true)
[ -n "$rrepo" ] || { echo "NO-REMOTE: sanad.remoteHost is $host, but this repository has no sanad.remoteRepo; run locally or set it."; exit 3; }
case "$rrepo" in *[\"\&\|\<\>\^%]*) echo "FAILED: sanad.remoteRepo holds a shell character"; exit 1;; esac
integ=$(git -C "$top" config --get sanad.integration || echo staging)

# The machine by its name first, then by each saved address (2026-11-08: the name stopped resolving
# while the address answered): git config --global --add sanad.remoteAddress <ip>.
via=()
reach() { ssh -o BatchMode=yes -o ConnectTimeout=12 "$@" "$host" "echo ok" >/dev/null 2>&1; }
if ! reach; then
  found=""
  for a in $(git config --get-all sanad.remoteAddress 2>/dev/null); do
    if reach -o "HostName=$a"; then found=$a; break; fi
  done
  [ -n "$found" ] || { echo "REMOTE-DOWN: $host does not answer by name or by any sanad.remoteAddress. Ask the user before running on this machine."; exit 4; }
  via=(-o "HostName=$found")
fi
ssh_q() { ssh -o BatchMode=yes -o ConnectTimeout=12 ${via[@]+"${via[@]}"} "$host" "$@"; }

# One sync at a time from this machine (2026-11-11: two proofs started together, the server's and the page's,
# shared the bundle's file name and the run ref; one deleted the bundle the other was fetching: "FAILED: fetch
# the bundle"). The second waits for the first. A lock whose process is gone is taken over.
lock="${SANAD_STATE_DIR:-$HOME/.claude/state}/remote-sync.lock"
mkdir -p "$(dirname "$lock")"
waited=0
until mkdir "$lock" 2>/dev/null; do
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$lock"; continue; fi
  # No owner written yet: its sync is starting. One left that way for a minute was killed there.
  if [ -z "$owner" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rm -rf "$lock"; continue; fi
  [ "$waited" -lt 600 ] || { echo "FAILED: another sync from this machine has run for 10 minutes ($lock)"; exit 1; }
  sleep 2; waited=$((waited + 2))
done
echo $$ > "$lock/pid"
tmp=$(mktemp -d); trap 'rm -rf "$tmp" "$lock"' EXIT
# The working tree as a commit, through a temporary index (the real index is never touched).
export GIT_INDEX_FILE="$tmp/index"
git -C "$top" read-tree HEAD || { echo "FAILED: read-tree"; exit 1; }
git -C "$top" add -A -- . 2>/dev/null || { echo "FAILED: could not read the working tree"; exit 1; }
tree=$(git -C "$top" write-tree) || { echo "FAILED: write-tree"; exit 1; }
unset GIT_INDEX_FILE
head=$(git -C "$top" rev-parse HEAD)
if [ "$tree" = "$(git -C "$top" rev-parse 'HEAD^{tree}')" ]; then commit=$head
else commit=$(git -C "$top" commit-tree "$tree" -p "$head" -m "sanad remote run (uncommitted work)") || { echo "FAILED: commit-tree"; exit 1; }; fi

# The remote fetches the integration branch itself; the bundle carries only what it lacks.
dirty=$(ssh_q "cd /d \"$rrepo\" && git status --porcelain --untracked-files=no" 2>/dev/null | tr -d '\r')
[ -z "$dirty" ] || { echo "REMOTE-DIRTY: $host:$rrepo has uncommitted changes:"; echo "$dirty" | head -5; exit 5; }
ssh_q "cd /d \"$rrepo\" && git fetch -q origin" >/dev/null 2>&1 || { echo "FAILED: git fetch on $host"; exit 1; }
base=$(git -C "$top" merge-base "origin/$integ" "$commit" 2>/dev/null || true)
ref="refs/sanad/remote-run"
git -C "$top" update-ref "$ref" "$commit"
if [ -n "$base" ] && [ "$base" != "$commit" ]; then range="$base..$ref"; else range="$ref"; fi
if [ "$range" = "$ref" ] && [ -n "$base" ]; then
  : # the commit is already on the integration branch: nothing to send
else
  git -C "$top" bundle create "$tmp/run.bundle" "$range" >/dev/null 2>&1 || { git -C "$top" update-ref -d "$ref"; echo "FAILED: bundle"; exit 1; }
  scp -q -o BatchMode=yes ${via[@]+"${via[@]}"} "$tmp/run.bundle" "$host:$rrepo/.git/sanad-run.bundle" || { git -C "$top" update-ref -d "$ref"; echo "FAILED: copy to $host"; exit 1; }
  ssh_q "cd /d \"$rrepo\" && git fetch -q -f .git/sanad-run.bundle +$ref:$ref && del .git\\sanad-run.bundle" >/dev/null 2>&1 || { git -C "$top" update-ref -d "$ref"; echo "FAILED: fetch the bundle on $host"; exit 1; }
fi
git -C "$top" update-ref -d "$ref"
ssh_q "cd /d \"$rrepo\" && git -c advice.detachedHead=false checkout -q --detach $commit" >/dev/null 2>&1 || { echo "FAILED: checkout on $host"; exit 1; }
got=$(ssh_q "cd /d \"$rrepo\" && git rev-parse HEAD^^{tree}" 2>/dev/null | tr -d '\r' | tail -1)
[ "$got" = "$tree" ] || { echo "FAILED: $host has tree $got, expected $tree"; exit 1; }
echo "SYNCED $host:$rrepo $commit tree $tree"
[ ${#via[@]} -eq 0 ] || echo "VIA ${via[1]#HostName=} (the name $host did not answer; this address did)"
echo "Run there: ssh ${via[@]+"${via[@]} "}$host \"cd /d $rrepo\\<subfolder> && <command>\""
