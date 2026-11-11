#!/usr/bin/env node
/*
 * stop-gate.js — Stop hook.
 * Enforces the CLAUDE.md Definition-of-Done mechanically: if code files were
 * edited this session and no PASSING build/test ran AFTER the last edit, block
 * the stop once and tell Claude to run the gate. On the re-stop
 * (stop_hook_active) it only warns — never loops. Pure-chat turns stay silent.
 *
 * What counts (see lib/transcript-scan.js):
 *  - an edit: Edit/Write/MultiEdit/NotebookEdit on a code file, OR a shell
 *    command that writes one (sed -i, > file.cs, tee, Set-Content, cp/mv,
 *    git apply, dotnet ef migrations add, package add/remove …). Auto mode
 *    edits through the shell, so shell writes must count or the gate is blind.
 *  - a verify: a completed build/test/typecheck command whose recorded result did
 *    NOT fail (non-zero exit, "Build FAILED", "error CS…", "Failed!", "N
 *    failed", npm ERR!, …). A failing build is not verification.
 *
 * Deterministic, no LLM. Fail-OPEN: any error → allow silently.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const path = require('path');

// A stop that goes through starts the task timer's idle wait (lib/timer-idle.cjs); a blocked stop does not.
// A GATE: PASS after the last code edit ends the task timer first (lib/timer-idle.cjs autoEnd, 2026-11-11).
var lastScan = null, stopBusy = false; // stopBusy: a check or helper of this work still runs (not idle time)
function markIdle() {
  try { if (lastScan) require('./lib/timer-idle.cjs').autoEnd(input, lastScan); } catch (e) { /* the timer never blocks a stop */ }
  try { require('./lib/timer-idle.cjs').idle(input, undefined, { busy: stopBusy }); } catch (e) { /* the timer never blocks a stop */ }
}
function out(obj) { if (!obj || obj.decision !== 'block') markIdle(); process.stdout.write(JSON.stringify(obj)); process.exit(0); }
function allow() { markIdle(); process.exit(0); }

function readStdin() {
  try {
    let s = fs.readFileSync(0, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  } catch (e) { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin().trim() || '{}'); } catch (e) { allow(); }

// Gate only the main-agent Stop event.
if (input.hook_event_name && input.hook_event_name !== 'Stop') allow();

const transcriptPath = input.transcript_path || '';
if (!transcriptPath || !fs.existsSync(transcriptPath)) allow();

let scan;
try { scan = require(path.join(__dirname, 'lib', 'transcript-scan.js')); } catch (e) { allow(); }

let r;
try { r = scan.scanTranscript(transcriptPath); } catch (e) { allow(); }
if (!r) allow();
lastScan = r;

/* ---------------------------------------------------------------------------
 * Verdict — exactly one of six exits:
 *   1. no code edit this session               → allow silently
 *   2. PASSING verify ran after the last edit  → allow + confirmation note
 *   3. a helper or a background check of this
 *      work still running, nothing failed      → allow + wait note (its finish returns here)
 *   4. unverified, already blocked once        → allow + warning (never loop)
 *   5. last verify after the edit FAILED       → block ONCE: fix, re-run
 *   6. no verify at all since the last edit    → block ONCE: run the gate
 * ------------------------------------------------------------------------- */

if (r.lastEdit === -1) allow();

// Same-tree memo. A git switch/pull/merge counts as a change, but when the
// folder it changed is clean and its tree is byte-identical to a tree a passing
// source-bound evidence check verified, nothing new exists to verify. A tree id
// names the content, so the same tree in another worktree or clone is the same
// code (2026-11-05: a checkout of the tested commit in the main folder kept
// asking for a rerun). Any git error → no memo.
function gitRead(args, cwd) {
  try {
    return require('child_process').execFileSync('git', args, { cwd: cwd || input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, windowsHide: true }).trim();
  } catch (e) { return null; }
}
let verifiedTree = '';
function verifiedTreeCheckedOut() {
  const trees = new Set(Array.isArray(r.passedTrees) ? r.passedTrees : []);
  const s = r.completedCheck && r.completedCheck.source;
  if (s && /^[0-9a-f]{40,64}$/i.test(String(s.treeAfter || ''))) trees.add(s.treeAfter);
  if (!trees.size) return false;
  const dir = r.lastGitRepo || input.cwd || process.cwd();
  if (gitRead(['status', '--porcelain'], dir) !== '') return false;        // null (error) or dirty: no memo
  const tree = gitRead(['rev-parse', 'HEAD^{tree}'], dir);
  if (!tree || !trees.has(tree)) return false;
  verifiedTree = tree;
  return true;
}
// Remote-ref memo. A move to a fetched remote ref (`git checkout --detach FETCH_HEAD`,
// `git switch --detach origin/staging`) after every other change, in a folder left
// clean, only shows upstream code: nothing new exists to verify (2026-11-09: reading
// the newest staging in the main folder asked for a build). Any git error → no memo.
function remoteRefsOnly() {
  const moves = Array.isArray(r.remoteCheckouts) ? r.remoteCheckouts : [];
  if (r.lastEditPath !== '<git-remote>' || !moves.length) return false;
  return [...new Set(moves.map((m) => m.repo))].every((dir) => !!dir && gitRead(['status', '--porcelain'], dir) === '');
}
const remoteOnly = remoteRefsOnly();
if (remoteOnly && (r.lastNonRemoteEdit ?? -1) === -1) allow();             // no code change of its own this session
const treeVerified = !remoteOnly && r.lastEditPath === '<git>' && verifiedTreeCheckedOut();
const lastEdit = remoteOnly ? r.lastNonRemoteEdit : treeVerified ? r.lastNonGitEdit : r.lastEdit;
const memo = treeVerified ? ' The checked-out tree is identical to one a passing evidence check verified (' + verifiedTree.slice(0, 12) + '), so the git-only change needs no rerun.'
  : remoteOnly ? ' The last change only moved a clean folder to a fetched remote ref, so it needs no rerun.' : '';

// A failure declared with `PROBE EXPECTED:` (a review probe that proves someone
// else's bug) does not block the stop; the push guard still counts it.
const failedAfterEdit = (r.lastFailedVerifyStop ?? r.lastFailedVerify) > lastEdit;
// Only a background command can still be running at a stop (see transcript-scan.js).
const pendingAfterEdit = (r.lastPendingVerifyStop ?? r.lastPendingVerify) > lastEdit;
if (!failedAfterEdit && !pendingAfterEdit && lastEdit === -1) {
  out({ systemMessage: 'No code change since the last passing evidence check.' + memo });
}
if (!failedAfterEdit && !pendingAfterEdit && r.lastVerify > lastEdit) {
  out({ systemMessage: 'A verification command completed successfully after the last code edit.' + memo + ' This is not the full Definition-of-Done: finish /gate with behavior evidence before /ship.' });
}
if (!failedAfterEdit && !pendingAfterEdit && r.lastProbeFailure > lastEdit) {
  out({ systemMessage: 'Declared review probe(s) failed as expected. That is evidence about the code under review, not verification of your own change; the push guard still refuses while they fail.' });
}
// A helper agent of the current work is still working (launched after the last passing check, even
// before the change, as a Test designer is): the task goes on when it reports, so the stop waits for
// it instead of asking for a check that cannot run yet (2026-11-06). Its finish brings the next stop
// back to this gate. A helper launched before a later passing check belongs to older work.
if (!failedAfterEdit && !pendingAfterEdit && (r.lastRunningHelper ?? -1) > r.lastVerify) {
  stopBusy = true;
  out({ systemMessage: 'A helper for this work is still running; the build/test check follows when its result is in.' });
}

// The check that blocks, named, so it is found at once (2026-11-06: hunting an unnamed one cost ~20 min).
function shown(command) { const c = String(command || '').replace(/\s+/g, ' ').trim(); return c ? (c.length > 160 ? c.slice(0, 157) + '…' : c) : 'unknown'; }
const file = /^<git(?:-remote)?>$/.test(r.lastEditPath) ? ' (last change: a git merge/reset/switch/stash)' : r.lastEditPath && r.lastEditPath !== '<generated>' ? ' (last edit: ' + path.basename(r.lastEditPath) + ')' : '';

// A live background check of the current work, and nothing failed: its finish notice brings the next
// stop back to this gate, so the stop waits instead of blocking. Blocking here only made every status
// reply during a remote suite repeat "still running" (2026-11-07). It is still not a passing result.
// A run no notice can bring back (finished without an exit code, or no task id) still blocks.
const stuckAfterEdit = (r.lastStuckVerifyStop ?? -1) > lastEdit;
if (!failedAfterEdit && pendingAfterEdit && !stuckAfterEdit) {
  stopBusy = true;
  out({ systemMessage: 'A build/test for this work is still running in the background: `' + shown(r.lastPendingVerifyStopCommand) + '`. Not verified yet; this check runs again when it finishes.' });
}

if (input.stop_hook_active) {
  out({
    systemMessage: failedAfterEdit
      ? '⛔ Gate NOT verified: the last build/test after your code edit FAILED. Run /gate before shipping.'
      : pendingAfterEdit ? '⛔ Gate NOT verified: a verification command\'s result was never collected. Collect it or rerun the check before shipping.'
      : '⛔ Gate NOT verified: code changed after the last passing build/test. Run /gate before shipping.',
  });
}

out({
  decision: 'block',
  reason: failedAfterEdit
    ? 'The last build/test run after your code edit FAILED' + file + ' — a failing run is not verification. ' +
      'Fix the cause, re-run the build and the relevant tests, quote their real output, then stop again. ' +
      'If it genuinely cannot pass here, say exactly what is failing and why instead of claiming success. ' +
      'The failed check: `' + shown(r.lastFailedVerifyStopCommand) + '`. ' +
      'If every failure is a timeout under machine load (not the code), rerun only the failed tests; to clear this run, send this line alone in a text-only message, with your rerun command filled in, then run that command exactly, which must pass: ' +
      'CHECK RETIRED: ' + JSON.stringify({ failed: r.lastFailedVerifyStopCommand || '<the failed command>', replacement: '<the rerun command>', reason: '<why>' })
    : pendingAfterEdit ? 'A build/test finished or was launched but its result was never collected' + file + ': `' + shown(r.lastStuckVerifyStopCommand) + '`. Read its TaskOutput, or rerun it in the foreground, fix any failure, then run /gate. Starting a background command is not a passing result.'
    : 'Code files were edited this session' + file + ' but no build/test has run since the last edit. ' +
      'Apply the Definition-of-Done at the cheapest correct rung (CLAUDE.md "Verify fast"): run the build and the relevant tests now, quote their real output, then stop again. ' +
      'If verification is genuinely impossible here (no toolchain, needs the user), say exactly what is unverified and why instead of claiming success.',
});
