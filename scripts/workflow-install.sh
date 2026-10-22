#!/usr/bin/env bash
# workflow-install.sh — install a tested workflow candidate as one versioned release.
#
# Usage: bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>
#   <candidate>  scratch copy with claude/... (mirrors ~/.claude), agents/skills/... (mirrors ~/.agents/skills), and codex/... (config.toml, AGENTS.md and agents/ in ~/.codex)
#   <base>       the untouched copy the candidate was made from (the drift reference)
#
# 1. Changed = files that differ between base and candidate (added, edited or removed).
# 2. Drift guard: every changed live file must still equal its base copy; otherwise abort untouched.
# 3. Back up every replaced/removed live file to ~/.claude/backups/<release-name>/.
# 4. Install, run the hook and gate suites, and append one line to ~/.claude/backups/RELEASES.md.
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

drift=0
for f in "${changed[@]}" "${removed[@]}"; do
  L="$(live "$f")"; [ -n "$L" ] || { echo "UNMAPPED: $f"; drift=1; continue; }
  if [ -f "$BASE/$f" ]; then cmp -s "$L" "$BASE/$f" || { echo "DRIFT: $f changed live since the candidate was made"; drift=1; }
  else [ -e "$L" ] && { echo "DRIFT: $f now exists live"; drift=1; }; fi
done
[ "$drift" = 0 ] || { echo "ABORTED: nothing was changed."; exit 1; }

for f in "${changed[@]}" "${removed[@]}"; do
  L="$(live "$f")"
  if [ -f "$L" ]; then mkdir -p "$B/$(dirname "$f")"; cp -p "$L" "$B/$f"; fi
done
for f in "${changed[@]}"; do L="$(live "$f")"; mkdir -p "$(dirname "$L")"; cp "$CAND/$f" "$L"; done
for f in "${removed[@]}"; do rm -f "$(live "$f")"; done
echo "INSTALLED ${#changed[@]} changed, ${#removed[@]} removed. Backup: $B"

# The native-runner test needs a real TypeScript install; use any repo's copy when the caller set none.
if [ -z "${WORKFLOW_TYPESCRIPT_RUNNER:-}" ]; then
  for c in "$HOME"/source/repos/*/node_modules/typescript/bin/tsc "$HOME"/source/repos/*/*/node_modules/typescript/bin/tsc; do
    [ -f "$c" ] && export WORKFLOW_TYPESCRIPT_RUNNER="$c" && break
  done
fi
hooks=$(cd "$C/hooks/tests" && node --test 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')
gate=$(cd "$C/skills/gate/tests" && node --test 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')
echo "hooks: $hooks"; echo "gate: $gate"
{ printf -- '- %s · %s · changed: %s' "$(date -u +%Y-%m-%dT%H:%MZ)" "$NAME" "${changed[*]}"
  [ ${#removed[@]} -gt 0 ] && printf ' · removed: %s' "${removed[*]}"
  printf ' · hooks: %s· gate: %s\n' "$hooks" "$gate"; } >> "$C/backups/RELEASES.md"
if echo "$hooks $gate" | grep -qE 'fail [1-9]'; then
  echo "TESTS FAILED after install. Restore with: cp -r \"$B/claude/.\" \"$C/\"; [ -d \"$B/agents/skills\" ] && cp -r \"$B/agents/skills/.\" \"$A/\"; [ -d \"$B/codex\" ] && cp -r \"$B/codex/.\" \"$X/\""
  exit 2
fi
