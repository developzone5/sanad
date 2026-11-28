#!/usr/bin/env bash
# workflow-install.sh — install a tested workflow candidate as one versioned release.
#
# Usage: bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>
#   <candidate>  scratch copy with claude/... (mirrors ~/.claude), agents/skills/... (mirrors ~/.agents/skills), and codex/... (config.toml, AGENTS.md and agents/ in ~/.codex)
#   <base>       the untouched copy the candidate was made from (the drift reference)
#
# 1. Changed = files that differ between base and candidate (added, edited or removed).
# 2. Drift guard: every changed live file must still equal its base copy; otherwise abort untouched.
#    Then the end-to-end runs on the test machine (sanad.e2eRun), with the candidate's own proof script,
#    and the drift guard once more, right before the first live write.
# 3. Back up every replaced/removed live file to ~/.claude/backups/<release-name>/, with manifest.txt:
#    every replaced, added and removed path.
# 4. Install and run the hook and gate suites. Both pass: one line in ~/.claude/backups/RELEASES.md.
#    One fails, or the install breaks half way: the manifest is undone (old files back, added files gone)
#    and the exit is non-zero. The backup folder and both suite logs stay for reading.
# One install at a time: the lock is the folder ~/.claude/backups/.install.lock.
set -euo pipefail

# A candidate may contain this very script. Bash reads a script as it runs, so
# overwriting it mid-install corrupts the run: always execute from a scratch copy.
if [ -z "${WORKFLOW_INSTALL_COPY:-}" ]; then
  _copy="$(mktemp "${TMPDIR:-/tmp}/workflow-install.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$_copy"
  WORKFLOW_INSTALL_COPY=1 exec bash "$_copy" "$@"
fi

CAND="${1:?candidate dir}"; BASE="${2:?base dir}"; NAME="${3:?release name}"
C="$HOME/.claude"; A="$HOME/.agents/skills"; X="$HOME/.codex"
B="$C/backups/$NAME"

# 2026-11-17 (audit I2): one install at a time, and a failed install undoes itself.
# The lock is a folder: `mkdir` without -p fails when the folder exists, so two installs can never both
# take it. The EXIT trap frees the lock and, while phase=writing (from the first live write until both
# suites pass), rolls the manifest back. A trap, because the rollback must also run when a command fails
# under set -e (a copy that breaks half way) or on Ctrl+C.
LOCK="$C/backups/.install.lock"; locked=0; made_backups=0; phase=check
rollback() {   # undo every live write the manifest names; safe on a half-done install
  local bad=0 kind f L d
  [ -r "$B/manifest.txt" ] || { echo "  manifest missing: $B/manifest.txt"; return 1; }
  while IFS=' ' read -r kind f; do
    case "$kind" in
      replaced|removed)
        L="$(live "$f")"
        { mkdir -p "$(dirname "$L")" && cp -p "$B/$f" "$L" && cmp -s "$B/$f" "$L"; } || { echo "  not restored: $f"; bad=1; } ;;
      added)
        L="$(live "$f")"; rm -f "$L" 2>/dev/null
        if [ -e "$L" ]; then echo "  not removed: $f"; bad=1; fi ;;
    esac
  done < "$B/manifest.txt"
  # Folders the install made, deepest first (reverse order puts a child before its parent).
  # One that is not empty again (somebody else's file) stays.
  { grep '^added-dir ' "$B/manifest.txt" || true; } | cut -d' ' -f2- | LC_ALL=C sort -ru \
    | while IFS= read -r d; do rmdir "$d" 2>/dev/null || true; done
  return "$bad"
}
finish() {
  local status=$?
  trap - EXIT; trap '' INT TERM HUP   # a second Ctrl+C must not cut the rollback short
  set +e
  # A suite still running (an exit while both run at once) is stopped before any file is put back.
  for _pid in "${hooks_pid:-}" "${gate_pid:-}"; do [ -n "$_pid" ] && { kill "$_pid" 2>/dev/null; wait "$_pid" 2>/dev/null; }; done
  if [ "$phase" = writing ]; then
    if rollback; then echo "ROLLED BACK: the previous files are live again"
    else
      echo "ROLLBACK NOT COMPLETE: finish it by hand from $B/manifest.txt (copy each 'replaced' and 'removed' path back from $B, delete each 'added' one)"
      status=4
    fi
    [ "$status" -ne 0 ] || status=1
  fi
  if [ "$locked" = 1 ]; then rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null; fi
  if [ "$made_backups" = 1 ]; then rmdir "$C/backups" 2>/dev/null; fi   # an abort leaves nothing new behind
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
if [ ! -d "$C/backups" ]; then mkdir -p "$C/backups"; made_backups=1; fi
if mkdir "$LOCK" 2>/dev/null; then
  locked=1; printf '%s, started %s\n' "$NAME" "$(date -u +%Y-%m-%dT%H:%MZ)" > "$LOCK/owner"
elif [ -d "$LOCK" ]; then
  echo "ABORTED: another install is running ($(cat "$LOCK/owner" 2>/dev/null || echo "no owner note")); nothing was changed. If none is running, remove $LOCK"
  exit 1
else
  echo "ABORTED: cannot create the lock folder $LOCK; nothing was changed."; exit 1
fi
[ -e "$B" ] && { echo "ABORTED: $B already exists"; exit 1; }

live() { case "$1" in claude/*) echo "$C/${1#claude/}";; agents/skills/*) echo "$A/${1#agents/skills/}";; codex/config.toml|codex/AGENTS.md|codex/agents/*.toml) echo "$X/${1#codex/}";; *) echo "";; esac; }

changed=(); removed=()
while IFS= read -r f; do
  if [ ! -f "$BASE/$f" ] || ! cmp -s "$BASE/$f" "$CAND/$f"; then changed+=("$f"); fi
done < <(cd "$CAND" && find claude agents codex -type f 2>/dev/null | sort)
while IFS= read -r f; do
  [ -f "$CAND/$f" ] || removed+=("$f")
done < <(cd "$BASE" && find claude agents codex -type f 2>/dev/null | sort)
[ ${#changed[@]} -eq 0 ] && [ ${#removed[@]} -eq 0 ] && { echo "Nothing to install."; exit 0; }
stamp() { echo "TIME: $1 $(date -u +%H:%M:%S)"; }
stamp start

# 2026-11-28 (owner, batch b task 4): the proof on the test machine and the replay run only when the change needs them.
# The candidate's claude/scripts/install-lists.mjs decides, from the changed and removed files: a file on no list, the
# installer itself or the lists file means every step runs; so does a lists file that is missing or cannot answer.
LISTS="$CAND/claude/scripts/install-lists.mjs"
e2e_need=run; e2e_why="every step runs (no lists file in the candidate)"; replay_need=run; replay_why="$e2e_why"
if [ -f "$LISTS" ]; then
  _changed_list="$(mktemp "${TMPDIR:-/tmp}/workflow-install-changed.XXXXXX")"
  printf '%s\n' "${changed[@]}" "${removed[@]}" > "$_changed_list"
  if _decided="$(node "$LISTS" decide "$_changed_list" 2>/dev/null)"; then
    _e2e_line="$(printf '%s\n' "$_decided" | grep '^E2E=' || true)"; _replay_line="$(printf '%s\n' "$_decided" | grep '^REPLAY=' || true)"
    # Only an exact "skip" leaves a step out; anything else (run, a broken line) keeps it.
    case "$_e2e_line" in E2E=skip*) e2e_need=skip;; esac
    case "$_replay_line" in REPLAY=skip*) replay_need=skip;; esac
    [ -n "$_e2e_line" ] && e2e_why="$(printf '%s\n' "$_e2e_line" | cut -f2-)"
    [ -n "$_replay_line" ] && replay_why="$(printf '%s\n' "$_replay_line" | cut -f2-)"
  else e2e_why="every step runs (the lists file could not answer)"; replay_why="$e2e_why"; fi
  rm -f "$_changed_list"
fi

# 2026-11-17 (audit I2): a function, because the guard runs twice: here, and again right before the first
# live write. The end-to-end runs between the two can take minutes, and a live file may change meanwhile.
drift_guard() {
  local drift=0 f L
  for f in "${changed[@]}" "${removed[@]}"; do
    L="$(live "$f")"; [ -n "$L" ] || { echo "UNMAPPED: $f"; drift=1; continue; }
    if [ -f "$BASE/$f" ]; then cmp -s "$L" "$BASE/$f" || { echo "DRIFT: $f changed live since the candidate was made"; drift=1; }
    else [ -e "$L" ] && { echo "DRIFT: $f now exists live"; drift=1; }; fi
  done
  [ "$drift" = 0 ]
}
drift_guard || { echo "ABORTED: nothing was changed."; exit 1; }

# End to end on the test machine, BEFORE anything is installed (2026-11-14: a release passed every local
# suite and CI, and the first real proof on the test machine crashed: a new shared file was missing from what
# the proof copies there). Each run uses the CANDIDATE's red-proof to warm one kept copy on the test machine,
# which copies the candidate's scripts there and loads them. Runs: SANAD_E2E_RUN (one per line) or every
# `git config --global sanad.e2eRun "<repo>|<folder in it>|<test command>"`. None set: said, never silent.
if [ -n "${SANAD_E2E_RUN+set}" ]; then e2e_runs="$SANAD_E2E_RUN"; else e2e_runs="$(git config --global --get-all sanad.e2eRun 2>/dev/null || true)"; fi
[ "$e2e_runs" = "none" ] && e2e_runs=""   # tests: SANAD_E2E_RUN=none skips the machine's own runs
if [ -z "$e2e_runs" ]; then
  echo "E2E: skipped — no run set (git config --global --add sanad.e2eRun \"<repo>|<folder>|<test command>\")"
elif [ "$e2e_need" = skip ]; then
  echo "E2E: left out — $e2e_why"
else
  echo "E2E: runs — $e2e_why"
  while IFS='|' read -r e2e_repo e2e_dir e2e_cmd; do
    [ -n "$e2e_repo" ] || continue
    echo "E2E: $e2e_repo ($e2e_dir): $e2e_cmd"
    # shellcheck disable=SC2086 — the command is words, split on purpose
    if ! node "$CAND/claude/skills/gate/scripts/red-proof.mjs" --repo "$e2e_repo" --warm --parallel 1 --cwd "$e2e_repo/$e2e_dir" -- $e2e_cmd; then
      echo "ABORTED: the candidate's proof did not run end to end on the test machine; nothing was changed."; exit 3
    fi
  done <<< "$e2e_runs"
fi

# Replay (2026-11-19): the base and the candidate readers answer every saved command, reviewer report and
# session; each difference is printed with its command or line. It only prints, unless the owner set
# `git config --global sanad.replayBlocks true`: then a difference not on the release's approved lines
# (claude/scripts/replay/approved.txt) stops the install here, before any live write. SANAD_REPLAY=none skips it.
REPLAY_JS="$CAND/claude/scripts/replay/replay.mjs"
stamp e2e-done
if [ "${SANAD_REPLAY:-}" = "none" ]; then echo "REPLAY: skipped (SANAD_REPLAY=none)"
elif [ ! -f "$REPLAY_JS" ]; then echo "REPLAY: skipped (the candidate has no replay script)"
elif [ "$replay_need" = skip ]; then echo "REPLAY: left out — $replay_why"
else
  echo "REPLAY: runs — $replay_why"
  replay_args=(run --base "$BASE" --cand "$CAND" --corpus "${SANAD_STATE_DIR:-$HOME/.claude/state}/replay-corpus")
  [ -f "$CAND/claude/scripts/replay/approved.txt" ] && replay_args+=(--approved "$CAND/claude/scripts/replay/approved.txt")
  replay_rc=0; node "$REPLAY_JS" "${replay_args[@]}" || replay_rc=$?
  replay_blocks="$(git config --global --get sanad.replayBlocks 2>/dev/null || true)"
  if [ "$replay_rc" = 4 ] && [ "$replay_blocks" = "true" ]; then
    echo "ABORTED: the replay found differences that are not approved; nothing was changed."; exit 3
  fi
  if [ "$replay_rc" != 0 ] && [ "$replay_rc" != 4 ]; then   # 0 = clean or approved, 4 = not approved; the rest is an error
    if [ "$replay_blocks" = "true" ]; then
      echo "ABORTED: the replay crashed (exit $replay_rc); nothing was changed."; exit 3
    fi
    echo "REPLAY: it crashed (exit $replay_rc); the install goes on because sanad.replayBlocks is not true."
  fi
fi

stamp replay-done
# The second drift guard (2026-11-17, audit I2): see drift_guard above. Still nothing written here.
drift_guard || { echo "ABORTED: live files changed during the end-to-end runs; nothing was changed."; exit 1; }

# Backup and manifest, complete, before the first live write (2026-11-17, audit I2: the old restore command
# copied the backup over the live folders and so left every ADDED file behind). manifest.txt names what a
# rollback undoes: "replaced <path>" and "removed <path>" (copied back from this folder), "added <path>"
# (deleted) and "added-dir <live folder>" (a folder the install makes; removed when empty again).
mkdir -p "$B"; : > "$B/manifest.txt"
for f in "${changed[@]}"; do
  L="$(live "$f")"
  if [ -f "$L" ]; then mkdir -p "$B/$(dirname "$f")"; cp -p "$L" "$B/$f"; echo "replaced $f" >> "$B/manifest.txt"
  else
    echo "added $f" >> "$B/manifest.txt"
    d="$(dirname "$L")"; while [ ! -d "$d" ]; do echo "added-dir $d" >> "$B/manifest.txt"; d="$(dirname "$d")"; done
  fi
done
for f in "${removed[@]}"; do
  L="$(live "$f")"
  if [ -f "$L" ]; then mkdir -p "$B/$(dirname "$f")"; cp -p "$L" "$B/$f"; echo "removed $f" >> "$B/manifest.txt"; fi
done
phase=writing   # from here until both suites pass, any exit rolls the manifest back (the EXIT trap)
# Only a hard kill (no trap runs) leaves the lock and half-written live files: the note says how to undo it.
printf '%s, writing live files since %s; if it was killed, undo it by hand from %s\n' "$NAME" "$(date -u +%Y-%m-%dT%H:%MZ)" "$B/manifest.txt" > "$LOCK/owner"
for f in "${changed[@]}"; do L="$(live "$f")"; mkdir -p "$(dirname "$L")"; cp "$CAND/$f" "$L"; done
for f in "${removed[@]}"; do rm -f "$(live "$f")"; done
echo "INSTALLED ${#changed[@]} changed, ${#removed[@]} removed. Backup: $B"

# The native-runner test needs a real TypeScript install; use any repo's copy when the caller set none.
if [ -z "${WORKFLOW_TYPESCRIPT_RUNNER:-}" ]; then
  for c in "$HOME"/source/repos/*/node_modules/typescript/bin/tsc "$HOME"/source/repos/*/*/node_modules/typescript/bin/tsc; do
    [ -f "$c" ] && export WORKFLOW_TYPESCRIPT_RUNNER="$c" && break
  done
fi
# --test-reporter=spec: Node 22 prints TAP ("# pass N") when stdout is not a terminal; without it
# the "ℹ pass N" lines are missing and the install ends with exit 1 (seen on the Sanad CI).
# `|| rc=$?`: a failing suite exits non-zero, and under pipefail that ended the script silently,
# before the lines below (seen 2026-11-05).
# 2026-11-14: each suite's full output is kept beside the backup, and a failing test is named below (an
# install printed "fail 1" and the output was gone, so nobody could tell which test failed).
# 2026-11-17 (audit I1): both commands ended in `|| true` and only "fail [1-9]" was searched, so a runner
# that could not start (exit 42, no summary at all) read as a clean install. Each suite's own exit is kept
# now, and a suite passes only with exit 0 AND a finished summary: "ℹ fail 0" and a pass count above 0.
# The summary adds to the exit; it never replaces it.
hooks_rc=0; gate_rc=0
# 2026-11-28 (owner, batch b task 4): both suites run at the same time, not one after the other. Each keeps its own
# command, log and verdict. So the machine is not busier than with one suite, the hook suite gets 2 test slots and
# the gate suite the rest (install-lists.mjs concurrency); a Node without --test-concurrency runs both as before.
conc_flag() {   # $1 = hooks|gate
  [ -f "$LISTS" ] || return 0
  node -e "process.exit(process.allowedNodeEnvironmentFlags.has('--test-concurrency') ? 0 : 1)" 2>/dev/null || return 0
  local n; n="$(node "$LISTS" concurrency "$1" 2>/dev/null || true)"
  case "$n" in ''|*[!0-9]*) return 0;; esac
  printf -- '--test-concurrency=%s' "$n"
}
hooks_conc="$(conc_flag hooks)"; gate_conc="$(conc_flag gate)"
stamp suites-start
# Colour off (audit I1 follow-up): FORCE_COLOR put a colour code before each summary line, so a green suite read as "no summary".
# shellcheck disable=SC2086 — an empty flag is no word
(cd "$C/hooks/tests" && env -u FORCE_COLOR NO_COLOR=1 node --test $hooks_conc --test-reporter=spec) > "$B/tests-hooks.log" 2>&1 & hooks_pid=$!
# shellcheck disable=SC2086
(cd "$C/skills/gate/tests" && env -u FORCE_COLOR NO_COLOR=1 node --test $gate_conc --test-reporter=spec) > "$B/tests-gate.log" 2>&1 & gate_pid=$!
wait "$hooks_pid" || hooks_rc=$?
wait "$gate_pid" || gate_rc=$?
hooks_pid=; gate_pid=
stamp suites-done
suite_ok() {   # $1 = the runner's own exit, $2 = its log
  [ "$1" -eq 0 ] && grep -aqE '^ℹ fail 0[[:space:]]*$' "$2" && grep -aqE '^ℹ pass [1-9][0-9]*[[:space:]]*$' "$2" \
    && ! grep -aqE '^ℹ fail [1-9]' "$2"
}
# A suite that failed only in the few named test files with a wall-clock limit (install-lists.mjs TIME_LIMIT_TESTS) runs
# those files again, alone, after both suites; they must pass there. Any other failing test is a real failure.
again_ok() {   # $1 = hooks|gate, $2 = its tests folder, $3 = its log; true when the files ran again alone and passed
  [ -f "$LISTS" ] || return 1
  local files; files="$(node "$LISTS" retry "$3" "$1" 2>/dev/null || echo NONE)"
  { [ -n "$files" ] && [ "$files" != NONE ]; } || return 1
  local rc=0 again="${3%.log}-again.log"
  # shellcheck disable=SC2046 — one word per file name
  (cd "$2" && env -u FORCE_COLOR NO_COLOR=1 node --test --test-reporter=spec $(printf '%s\n' "$files")) > "$again" 2>&1 || rc=$?
  suite_ok "$rc" "$again" || return 1
  echo "SUITE $1: only test files with a wall-clock limit failed under the load of both suites, and they passed alone: $(printf '%s ' $files)(log: $again)"
}
hooks=$(grep -aE '^ℹ (pass|fail)' "$B/tests-hooks.log" 2>/dev/null | tr '\n' ' ') || true
gate=$(grep -aE '^ℹ (pass|fail)' "$B/tests-gate.log" 2>/dev/null | tr '\n' ' ') || true
echo "hooks: $hooks"; echo "gate: $gate"
failed=0
suite_ok "$hooks_rc" "$B/tests-hooks.log" || again_ok hooks "$C/hooks/tests" "$B/tests-hooks.log" || { echo "  suite failed (tests-hooks): exit $hooks_rc, summary: ${hooks:-none}"; failed=1; }
suite_ok "$gate_rc" "$B/tests-gate.log" || again_ok gate "$C/skills/gate/tests" "$B/tests-gate.log" || { echo "  suite failed (tests-gate): exit $gate_rc, summary: ${gate:-none}"; failed=1; }
if [ "$failed" = 1 ]; then
  for log in "$B/tests-hooks.log" "$B/tests-gate.log"; do
    { grep -aE '^✖ ' "$log" 2>/dev/null || true; } | grep -v '^✖ failing tests:' | sed -E 's/ \([0-9.]+ms\)$//' | sort -u | head -10 \
      | sed "s|^✖ |  failed ($(basename "$log" .log)): |" || true   # a log with no failing line is not an error
  done
  echo "Full test output: $B/tests-hooks.log and $B/tests-gate.log"
  echo "TESTS FAILED after install."
  exit 2   # phase is still "writing": the EXIT trap rolls the install back and says so (2026-11-17, audit I2)
fi
# The release line is written only now, for an install that stays (2026-11-17, audit I2: it used to be
# written before the verdict, so a failed install was logged as a release).
{ printf -- '- %s · %s · changed: %s' "$(date -u +%Y-%m-%dT%H:%MZ)" "$NAME" "${changed[*]}"
  [ ${#removed[@]} -gt 0 ] && printf ' · removed: %s' "${removed[*]}"
  printf ' · hooks: %s· gate: %s\n' "$hooks" "$gate"; } >> "$C/backups/RELEASES.md"
phase=done
