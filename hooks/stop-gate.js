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

function out(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }
function allow() { process.exit(0); }

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

/* ---------------------------------------------------------------------------
 * Verdict — exactly one of five exits:
 *   1. no code edit this session               → allow silently
 *   2. PASSING verify ran after the last edit  → allow + confirmation note
 *   3. unverified, already blocked once        → allow + warning (never loop)
 *   4. last verify after the edit FAILED       → block ONCE: fix, re-run
 *   5. no verify at all since the last edit    → block ONCE: run the gate
 * ------------------------------------------------------------------------- */

if (r.lastEdit === -1) allow();

// Same-tree memo. A git switch/pull/merge counts as a change, but when the
// checked-out source is byte-identical to the tree the last passing
// source-bound evidence check verified, nothing new exists to verify. Tree
// identity is the same proof the push guard relies on. Any git error → no memo.
function gitRead(args) {
  try {
    return require('child_process').execFileSync('git', args, { cwd: input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, windowsHide: true }).trim();
  } catch (e) { return null; }
}
function verifiedTreeCheckedOut() {
  const s = r.completedCheck && r.completedCheck.source;
  if (!s || !s.toplevel || !/^[0-9a-f]{40,64}$/i.test(String(s.treeAfter || ''))) return false;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const top = gitRead(['rev-parse', '--show-toplevel']);
  if (!top || norm(top) !== norm(s.toplevel)) return false;
  if (gitRead(['status', '--porcelain']) !== '') return false;             // null (error) or dirty: no memo
  return gitRead(['rev-parse', 'HEAD^{tree}']) === s.treeAfter;
}
const treeVerified = r.lastEditPath === '<git>' && verifiedTreeCheckedOut();
const lastEdit = treeVerified ? r.lastNonGitEdit : r.lastEdit;
const memo = treeVerified ? ' The checked-out tree is identical to the one the last passing evidence check verified (' + r.completedCheck.source.treeAfter.slice(0, 12) + '), so the git-only change needs no rerun.' : '';

// A failure declared with `PROBE EXPECTED:` (a review probe that proves someone
// else's bug) does not block the stop; the push guard still counts it.
const failedAfterEdit = (r.lastFailedVerifyStop ?? r.lastFailedVerify) > lastEdit;
const pendingAfterEdit = r.lastPendingVerify > lastEdit;
if (!failedAfterEdit && !pendingAfterEdit && lastEdit === -1) {
  out({ systemMessage: 'No code change since the last passing evidence check.' + memo });
}
if (!failedAfterEdit && !pendingAfterEdit && r.lastVerify > lastEdit) {
  out({ systemMessage: 'A verification command completed successfully after the last code edit.' + memo + ' This is not the full Definition-of-Done: finish /gate with behavior evidence before /ship.' });
}
if (!failedAfterEdit && !pendingAfterEdit && r.lastProbeFailure > lastEdit) {
  out({ systemMessage: 'Declared review probe(s) failed as expected. That is evidence about the code under review, not verification of your own change; the push guard still refuses while they fail.' });
}
const file = r.lastEditPath === '<git>' ? ' (last change: a git merge/reset/switch/stash)' : r.lastEditPath && r.lastEditPath !== '<generated>' ? ' (last edit: ' + path.basename(r.lastEditPath) + ')' : '';

if (input.stop_hook_active) {
  out({
    systemMessage: failedAfterEdit
      ? '⛔ Gate NOT verified: the last build/test after your code edit FAILED. Run /gate before shipping.'
      : pendingAfterEdit ? '⛔ Gate NOT verified: a verification command is still pending. Collect its completed result before shipping.'
      : '⛔ Gate NOT verified: code changed after the last passing build/test. Run /gate before shipping.',
  });
}

out({
  decision: 'block',
  reason: failedAfterEdit
    ? 'The last build/test run after your code edit FAILED' + file + ' — a failing run is not verification. ' +
      'Fix the cause, re-run the build and the relevant tests, quote their real output, then stop again. ' +
      'If it genuinely cannot pass here, say exactly what is failing and why instead of claiming success.'
    : pendingAfterEdit ? 'A build/test is still running or its completion has not been collected' + file + '. Read its completed TaskOutput, fix any failure, then run /gate. Starting a background command is not a passing result.'
    : 'Code files were edited this session' + file + ' but no build/test has run since the last edit. ' +
      'Apply the Definition-of-Done at the cheapest correct rung (CLAUDE.md "Verify fast"): run the build and the relevant tests now, quote their real output, then stop again. ' +
      'If verification is genuinely impossible here (no toolchain, needs the user), say exactly what is unverified and why instead of claiming success.',
});
