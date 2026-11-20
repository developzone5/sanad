#!/usr/bin/env node
/*
 * session-start.js — SessionStart hook.
 * Prints the git/PR state CLAUDE.md wants checked BEFORE any work, so it no
 * longer depends on Claude remembering a memory rule:
 *   - current branch + the integration branch (staging → develop → dev)
 *   - one line per owner rule switch that is on (git config sanad.*), none when none is on
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
const path = require('path');
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
  return exitCode(cmd, args, timeout) === 0;
}
function exitCode(cmd, args, timeout) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'ignore', timeout: timeout || 8000, windowsHide: true });
    return 0;
  } catch (e) { return typeof e.status === 'number' ? e.status : -1; }
}

// These lines show the settings Git reads at startup. They do not prove who set them.
const YES = (v) => /^(?:true|yes|on|1)$/i.test(v);
const TRUE = (v) => v.trim().toLowerCase() === 'true';
// The task tool reads these values from the first line of Git's output.
const taskValue = (v) => v.split(/\r?\n/, 1)[0].trimStart();
const roundOf = (v) => Number(taskValue(v));
const validRound = (n) => Number.isInteger(n) && n >= 2;
const OWNER_SWITCHES = [
  { key: 'sanad.lane', on: (v) => v.trim().toLowerCase() === 'workflow', means: () => 'a push from this clone skips the independent reviewer' },
  { key: 'sanad.ticketRequired', on: (v) => v.trim() === 'false', means: () => 'a commit subject needs no ticket ID' },
  { key: 'sanad.stopRound', on: (v) => validRound(roundOf(v)) && roundOf(v) !== 3, means: (v) => 'review rounds stop after round ' + roundOf(v) + ', not round 3' },
  { key: 'sanad.testsOnlyLane', on: (v) => YES(taskValue(v)), means: () => 'a change that touches only tests takes the light path' },
  { key: 'sanad.designChoice', on: (v) => YES(taskValue(v)), means: () => 'the owner chooses between the two designs before a big design is built' },
  { key: 'sanad.carryDecision', on: TRUE, means: () => 'an answer the owner gave in this task can close a later note about the same thing' },
  // The installer compares its Git command output to the exact word true.
  { key: 'sanad.replayBlocks', on: (v) => v.replace(/\n+$/, '') === 'true', global: true, means: () => 'an install stops on a replay difference that is not approved' },
];
const SCOPE_NAME = { local: 'this repository', worktree: 'this repository', global: 'global', system: 'system', command: 'command line' };
const SWITCH_KEYS = '^sanad\\.(' + OWNER_SWITCHES.map((sw) => sw.key.split('.')[1].toLowerCase()).join('|') + ')$';
function shown(v, limit) {
  const s = v.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}
function switchRecords(pattern, ...options) {
  // Git separates scope, origin and each key/value pair with NUL.
  const parts = run('git', ['config', '-z', '--show-scope', '--show-origin', ...options, '--get-regexp', pattern]).split('\0');
  const records = [];
  for (let i = 0; i + 3 < parts.length; i += 3) {
    const [scope, origin, entry] = parts.slice(i, i + 3);
    const nl = entry.indexOf('\n');
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    records.push({ key, scope, origin, value: nl < 0 ? '' : entry.slice(nl + 1) });
  }
  return records;
}

function ownerSwitchLines() {
  const used = new Map();
  const replay = 'sanad.replayblocks';
  let globalReplay = false;
  for (const record of switchRecords(SWITCH_KEYS)) {
    used.set(record.key, record);
    if (record.key === replay && record.scope === 'global') globalReplay = true;
  }
  // Match the installer's global lookup, which uses Git's global include rules.
  const replayRecord = globalReplay ? switchRecords('^sanad\\.replayblocks$', '--global').pop() : null;
  const lines = [];
  for (const sw of OWNER_SWITCHES) {
    const hit = sw.global ? replayRecord : used.get(sw.key.toLowerCase());
    if (!hit) continue;
    const scope = SCOPE_NAME[hit.scope] || 'unknown scope';
    const setting = sw.key + ' = ' + shown(hit.value, 40) + ' (' + scope + ')';
    const origin = ' [origin: ' + shown(hit.origin, 160) + ']';
    if (sw.key === 'sanad.stopRound' && hit.value.trim() && !validRound(roundOf(hit.value))) {
      lines.push('Owner switch invalid: ' + setting + ' — use a whole number of 2 or more' + origin);
    } else if (sw.on(hit.value)) {
      lines.push('Owner switch on: ' + setting + ' — ' + sw.means(hit.value) + origin);
    }
  }
  return lines;
}

try {
  if (run('git', ['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0);

  const fetched = succeeds('git', ['fetch', 'origin', '--quiet', '--prune'], 10000);
  const stale = fetched ? '' : ' (⚠ last fetched state — fetch failed)';
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || '(detached)';
  const remotes = run('git', ['branch', '-r', '--format=%(refname:short)']).split('\n').map((s) => s.trim());
  // A clone may name its own integration branch (`git config sanad.integration main` on a solo repo).
  const configured = run('git', ['config', '--get', 'sanad.integration']);
  const integ = [configured, 'staging', 'develop', 'dev'].filter(Boolean).find((b) => remotes.includes('origin/' + b)) || null;
  const PROD = /^(main|master|prod|production|release(\/.+)?)$/i;

  const lines = [];
  if (!fetched) lines.push('⚠ git fetch origin failed or timed out — remote comparisons below may be stale; fetch successfully before shipping.');
  lines.push('Branch: ' + branch + (integ
    ? ' · integration branch: ' + integ
    : ' · ⚠ no staging/develop/dev on origin — ask which branch is the PR base before shipping'));
  for (const l of ownerSwitchLines()) lines.push(l);
  // The stack, read from the repository's own project files (saved; re-read only when one changes).
  const stackScript = path.join(__dirname, '..', 'skills', 'gate', 'scripts', 'stack.mjs');
  const stack = fs.existsSync(stackScript) ? run(process.execPath, [stackScript, '--repo', cwd], 8000) : '';
  if (/^Stack: /.test(stack) && !/no known stack files/.test(stack)) lines.push(stack);

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
    // Behind is no reason to merge (2026-11-15: merging an unrelated staging commit made a new tree, and the full
    // suite ran again for it). Only a conflict is: the PR's own checks test the combined code. Nothing is written.
    let note = '';
    if (Number(behind) > 0) {
      const merge = exitCode('git', ['merge-tree', '--write-tree', '--quiet', 'origin/' + integ, 'HEAD'], 15000);
      note = merge === 0 ? ' — no conflict: no merge needed, the PR checks test the combined code'
        : merge === 1 ? ' — ⚠ conflicts with origin/' + integ + ': merge it into this branch before the ship brief'
          : ' — merge only on a conflict (/ship step 1)';
    }
    lines.push('vs origin/' + integ + ': ahead ' + (ahead || 0) + ', behind ' + (behind || 0) + stale + note);
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
