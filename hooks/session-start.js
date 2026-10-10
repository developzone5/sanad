#!/usr/bin/env node
/*
 * session-start.js — SessionStart hook.
 * Prints the git/PR state CLAUDE.md wants checked BEFORE any work, so it no
 * longer depends on Claude remembering a memory rule:
 *   - current branch + the integration branch (staging → develop → dev)
 *   - ahead/behind upstream and vs origin/<integration> (fresh `git fetch`)
 *   - uncommitted file count
 *   - the branch's PR (number, state, draft, base) — and a loud warning when
 *     that PR is already MERGED (start a new branch off fresh origin/<integ>)
 *   - a warning when sitting on a shared branch
 *
 * stdout becomes session context. Not a git repo / git missing → prints
 * nothing; offline → prints local state and labels remote data as stale.
 * Fail-OPEN, never blocks.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

function readStdin() {
  try {
    let s = fs.readFileSync(0, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  } catch (e) { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin().trim() || '{}'); } catch (e) { input = {}; }
const cwd = input.cwd || process.cwd();

function run(cmd, args, timeout) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeout || 8000, windowsHide: true }).trim();
  } catch (e) { return ''; }
}
// A quiet fetch prints nothing on success, so judge it by its exit status.
function succeeds(cmd, args, timeout) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'ignore', timeout: timeout || 8000, windowsHide: true });
    return true;
  } catch (e) { return false; }
}

try {
  if (run('git', ['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0);

  const fetched = succeeds('git', ['fetch', 'origin', '--quiet', '--prune'], 10000);
  const stale = fetched ? '' : ' (⚠ last fetched state — fetch failed)';
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || '(detached)';
  const remotes = run('git', ['branch', '-r', '--format=%(refname:short)']).split('\n').map((s) => s.trim());
  const integ = ['staging', 'develop', 'dev'].find((b) => remotes.includes('origin/' + b)) || null;
  const PROD = /^(main|master|prod|production|release(\/.+)?)$/i;

  const lines = [];
  if (!fetched) lines.push('⚠ git fetch origin failed or timed out — remote comparisons below may be stale; fetch successfully before shipping.');
  lines.push('Branch: ' + branch + (integ
    ? ' · integration branch: ' + integ
    : ' · ⚠ no staging/develop/dev on origin — ask which branch is the PR base before shipping'));

  const dirty = run('git', ['status', '--porcelain']).split('\n').filter(Boolean).length;
  const up = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up) {
    const [behind, ahead] = run('git', ['rev-list', '--left-right', '--count', up + '...HEAD']).split(/\s+/);
    lines.push('Upstream ' + up + ': ahead ' + (ahead || 0) + ', behind ' + (behind || 0) + stale + ' · uncommitted files: ' + dirty);
  } else {
    lines.push('No upstream (never pushed) · uncommitted files: ' + dirty);
  }

  if (integ && branch !== integ && branch !== '(detached)') {
    const [behind, ahead] = run('git', ['rev-list', '--left-right', '--count', 'origin/' + integ + '...HEAD']).split(/\s+/);
    lines.push('vs origin/' + integ + ': ahead ' + (ahead || 0) + ', behind ' + (behind || 0) + stale +
      (Number(behind) > 0 ? ' — ⚠ merge origin/' + integ + ' into this branch before the ship brief' : ''));
  }

  if (branch !== '(detached)' && !PROD.test(branch) && branch !== integ) {
    const prJson = run('gh', ['pr', 'view', '--json', 'number,state,isDraft,baseRefName,url'], 20000);
    if (prJson) {
      try {
        const pr = JSON.parse(prJson);
        lines.push('PR #' + pr.number + ' ' + pr.state + (pr.isDraft ? ' (draft)' : '') + ' → base ' + pr.baseRefName + ' · ' + pr.url);
        if (pr.state === 'MERGED') {
          lines.push('⚠ PR #' + pr.number + ' is already MERGED — do NOT push more commits to ' + branch +
            '. Start a new branch: git checkout -b <type>/<name> origin/' + (integ || 'staging'));
        } else if (integ && pr.baseRefName !== integ) {
          lines.push('⚠ PR base is ' + pr.baseRefName + ', not ' + integ);
        }
      } catch (e) { lines.push('PR: (could not parse gh output)'); }
    } else {
      lines.push('PR: none for this branch (or gh unavailable)');
    }
  }

  if (PROD.test(branch) || branch === integ) {
    lines.push('⚠ On shared branch ' + branch + ' — create a feature branch off origin/' + (integ || branch) + ' before editing anything');
  }

  process.stdout.write('Session start — git state (auto, ~/.claude/hooks/session-start.js):\n' + lines.join('\n') + '\n');
} catch (e) { /* fail-open */ }
process.exit(0);
