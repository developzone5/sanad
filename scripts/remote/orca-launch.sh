#!/usr/bin/env bash
# orca-launch.sh — start one Claude agent on a remote Orca host that reads a brief file.
#
# Usage: bash ~/.claude/scripts/remote/orca-launch.sh [--role <role>] <environment> <remote-worktree> <remote-brief> ["one-line note"]
#   --role             picks the model the same way Sanad does on the local machine (default: code)
#                        code         writes or fixes code              Opus 5.5
#                        risk-review  risk files / fresh whole-PR review Opus 5.5
#                        review       whole-diff review                 Sonnet 5.5
#                        recheck      re-check of changed lines         Sonnet 5.5
#                        chore        tests, logs, data, design compare Sonnet 5.5
#                        judge        final judgement over reports      Fable 5.1
#   <environment>      saved Orca environment name (also the SSH alias unless ORCA_SSH_HOST is set)
#   <remote-worktree>  workspace path on the remote, e.g. C:/Users/me/source/repos/App
#   <remote-brief>     brief file path on the remote; it must already exist there
# Prints LAUNCHED <handle> (<model banner>), STUCK <handle> (the agent shows a question),
# MODEL MISMATCH <handle> or NOT SEEN <handle>.
# The remote shell is assumed to be Windows cmd (the existence check uses `if exist`).
set -euo pipefail

ROLE=code
if [ "${1:-}" = "--role" ]; then ROLE="${2:?role}"; shift 2; fi
case "$ROLE" in
  code | risk-review) MODEL_ID=claude-opus-5-5; MODEL_NAME='Opus 5.5' ;;
  review | recheck | chore) MODEL_ID=claude-sonnet-5-5; MODEL_NAME='Sonnet 5.5' ;;
  judge) MODEL_ID=claude-fable-5-1; MODEL_NAME='Fable 5.1' ;;
  *) echo "REFUSED: unknown role '$ROLE' (code, risk-review, review, recheck, chore, judge)"; exit 2 ;;
esac

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
PROMPT="Engine: Claude (already chosen; do not ask). Read the brief at $BRIEF and follow it exactly.${NOTE:+ $NOTE}${PART} Nobody can answer a permission prompt here, so never run a command that asks for one: no package or tool installs, no rm -rf (use a new folder name instead), no git checkout -- / restore / reset / clean / stash on changed files (commit or copy instead). Do not push."
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
    case "$BANNER" in
      "$MODEL_NAME with xhigh effort") echo "LAUNCHED $HANDLE ($ROLE: $BANNER)"; exit 0 ;;
      "") echo "LAUNCHED $HANDLE ($ROLE: banner not seen; expected $MODEL_NAME xhigh)"; exit 0 ;;
      *) echo "MODEL MISMATCH $HANDLE (role $ROLE wants $MODEL_NAME xhigh, banner says: $BANNER)"; exit 5 ;;
    esac
  fi
done
echo "NOT SEEN $HANDLE (prompt not echoed after 60 s; read the terminal)"; exit 4
