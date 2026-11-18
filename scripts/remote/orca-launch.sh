#!/usr/bin/env bash
# orca-launch.sh — start one Claude agent on a remote Orca host that reads a brief file.
#
# Usage: bash ~/.claude/scripts/remote/orca-launch.sh [--engine claude] [--role <role>] <environment> <remote-worktree> <remote-brief> ["one-line note"]
#   --engine           the task's engine (default claude). codex is refused in one line: remote launches start Claude
#                      agents only, and a Codex task never gets one without the user knowing.
#   --role             picks the model the same way Sanad does on the local machine (default: code). Each is a
#                      Claude alias — always the newest model of that family, so no version is ever pinned here
#                      (2026-11-10: this file still launched Fable 5.1 after the boss had moved on).
#                        code         writes or fixes code              opus
#                        risk-review  risk files / fresh whole-PR review opus
#                        review       whole-diff review                 sonnet
#                        recheck      re-check of changed lines         sonnet
#                        chore        tests, logs, data, design compare sonnet
#                        tests        adds tests, changes no product code sonnet
#                        judge       final judgement over reports      fable
#   <environment>      saved Orca environment name (also the SSH alias unless ORCA_SSH_HOST is set)
#   <remote-worktree>  workspace path on the remote, e.g. C:/Users/me/source/repos/App
#   <remote-brief>     brief file path on the remote; it must already exist there
# Options go before the positional arguments; one after them is refused (2026-11-18).
# Prints LAUNCHED <handle> (engine <engine>, <role>: <model banner>), STUCK <handle> (the agent shows a question),
# MODEL MISMATCH <handle> or NOT SEEN <handle>.
# The remote shell is assumed to be Windows cmd (the existence check uses `if exist`).
set -euo pipefail

ROLE=code
ENGINE=claude
# 2026-11-18 (audit finding 6): --engine and --role may come in either order. The prompt and the agent below are Claude's;
# a Codex task is refused, never started as a Claude agent (no tested Codex path exists here).
while [ "${1:-}" = "--role" ] || [ "${1:-}" = "--engine" ]; do
  if [ "$1" = "--role" ]; then ROLE="${2:?role}"; else ENGINE="${2:?engine}"; fi
  shift 2
done
case "$ENGINE" in
  claude) ;;
  codex) echo "REFUSED: remote launches support Claude tasks only; this task's engine is Codex, so nothing was started"; exit 2 ;;
  *) echo "REFUSED: unknown engine '$ENGINE' (claude)"; exit 2 ;;
esac
case "$ROLE" in
  code | risk-review) MODEL_ID=opus; MODEL_NAME='Opus' ;;
  review | recheck | chore | tests) MODEL_ID=sonnet; MODEL_NAME='Sonnet' ;;
  judge) MODEL_ID=fable; MODEL_NAME='Fable' ;;
  *) echo "REFUSED: unknown role '$ROLE' (code, risk-review, review, recheck, chore, tests, judge)"; exit 2 ;;
esac

# 2026-11-18 (audit finding 3): options are read only before the positional arguments. One after them (or --engine=codex)
# used to be ignored and a Claude agent started for a Codex task, or the word landed in the prompt as the note.
[ "$#" -le 4 ] || { echo "REFUSED: too many arguments; the options (--engine, --role) go before <environment>, and the note is one quoted argument"; exit 2; }
for a in "$@"; do
  case "$a" in --*) echo "REFUSED: '$a' is read as an option but comes in the wrong place or form; use '--engine <name>' and '--role <name>' before <environment>"; exit 2 ;; esac
done
ENV="${1:?environment}"; WT="${2:?remote worktree}"; BRIEF="${3:?remote brief path}"; NOTE="${4:-}"
SSH_HOST="${ORCA_SSH_HOST:-$ENV}"

# A shell variable or backtick in the prompt reaches the agent as literal text.
for v in "$ENV" "$WT" "$BRIEF" "$NOTE"; do
  case "$v" in *'$'* | *'`'*) echo "REFUSED: an argument contains \$ or a backtick; pass literal text only"; exit 2 ;; esac
done

# The brief must exist on the remote. SSH first; when SSH cannot connect (exit 255), ask through Orca.
set +e
ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" "if exist \"$BRIEF\" (exit 0) else (exit 1)" >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" = 255 ]; then
  T="$(timeout 60 orca terminal create --environment "$ENV" --worktree "path:$WT" --shell cmd.exe --title "brief check" \
    --command "if exist \"$BRIEF\" (echo BRIEF_FOUND) else (echo BRIEF_MISSING)" 2>/dev/null | grep -o 'term_[a-z0-9-]*' | head -1 || true)"
  sleep 4
  CHECK="$( [ -n "$T" ] && timeout 30 orca terminal read --environment "$ENV" --terminal "$T" 2>/dev/null || true)"
  [ -n "$T" ] && timeout 20 orca terminal close --environment "$ENV" --terminal "$T" >/dev/null 2>&1 || true
  if echo "$CHECK" | grep -qx 'BRIEF_FOUND'; then rc=0; else rc=1; fi
fi
[ "$rc" = 0 ] || { echo "REFUSED: brief not found on $SSH_HOST: $BRIEF (copy it there first)"; exit 2; }

PART=""
[ "$ROLE" = code ] && PART=" You build one part of a larger task: write the code and its tests, run the checks, commit and report. Do not start reviewer agents and skip Sanad's review step; the main session reviews every part together, with the other engine."
[ "$ROLE" = tests ] && PART=" You add tests for code that already works. Change no product code. A new test that fails may be a real bug: do not fix it and do not commit it; write it and its failure in your report."
PROMPT="Engine: Claude (already chosen; do not ask). Read the brief at $BRIEF and follow it exactly.${NOTE:+ $NOTE}${PART} Nobody can answer a permission prompt here, so never run a command that asks for one: no package or tool installs, no rm -rf (use a new folder name instead), no git checkout -- / restore / reset / clean / stash on changed files (commit or copy instead), no low-level git commands or git environment settings (update-index, read-tree, commit-tree, GIT_INDEX_FILE). To prove a test against broken code, use red-proof.mjs --break. Do not push."
OUT="$(timeout 120 orca agent launch --environment "$ENV" --agent claude --worktree "path:$WT" \
  --model "$MODEL_ID" --effort xhigh --prompt "$PROMPT" 2>&1)" || {
  echo "LAUNCH FAILED:"; echo "$OUT" | tail -5; exit 1
}
HANDLE="$(echo "$OUT" | sed -n 's/^handle: *//p' | head -1 | tr -d '\r')"
[ -n "$HANDLE" ] || { echo "LAUNCH FAILED: no terminal handle in the reply:"; echo "$OUT" | tail -5; exit 1; }

# The terminal wraps long lines, so look for the brief's file name, not its whole path.
NAME="${BRIEF##*[\\/]}"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 5
  SCREEN="$(timeout 60 orca terminal read --environment "$ENV" --terminal "$HANDLE" 2>/dev/null || true)"
  if echo "$SCREEN" | grep -q "Enter to select"; then echo "STUCK $HANDLE (the agent is asking a question)"; exit 3; fi
  if echo "$SCREEN" | grep -qF "$NAME"; then
    BANNER="$(echo "$SCREEN" | grep -o -m1 '[A-Z][a-z]* [0-9.]* with [a-z]* effort' || true)"
    # Any version of the role's family is right (the alias picks the newest); only the family and effort are checked.
    case "$BANNER" in
      "$MODEL_NAME "[0-9]*" with xhigh effort") echo "LAUNCHED $HANDLE (engine $ENGINE, $ROLE: $BANNER)"; exit 0 ;;
      "") echo "LAUNCHED $HANDLE (engine $ENGINE, $ROLE: banner not seen; expected $MODEL_NAME xhigh)"; exit 0 ;;
      *) echo "MODEL MISMATCH $HANDLE (role $ROLE wants $MODEL_NAME xhigh, banner says: $BANNER)"; exit 5 ;;
    esac
  fi
done
echo "NOT SEEN $HANDLE (prompt not echoed after 60 s; read the terminal)"; exit 4
