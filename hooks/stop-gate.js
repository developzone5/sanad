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

// A failure declared with `PROBE EXPECTED:` (a review probe that proves someone
// else's bug) does not block the stop; the push guard still counts it.
const failedAfterEdit = (r.lastFailedVerifyStop ?? r.lastFailedVerify) > r.lastEdit;
const pendingAfterEdit = r.lastPendingVerify > r.lastEdit;
if (!failedAfterEdit && !pendingAfterEdit && r.lastVerify > r.lastEdit) {
  out({ systemMessage: 'A verification command completed successfully after the last code edit. This is not the full Definition-of-Done: finish /gate with behavior evidence before /ship.' });
}
if (!failedAfterEdit && !pendingAfterEdit && r.lastProbeFailure > r.lastEdit) {
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
