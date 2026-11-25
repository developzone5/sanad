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
 *    failed", npm ERR!, …). A failing build is not verification. A red-proof
 *    --then-green run counts by its green run, also when its output went to a
 *    file: then its run record decides (2026-11-15).
 *  - an open reviewer note (2026-11-12): a final text that says REVIEW/GATE: PASS
 *    or hands over a push command blocks, even in a chat-only turn, until each
 *    note is fixed or the user decided it (see transcript-scan.js "Reviewer notes").
 *    With the host's final text this holds on repeated stops too (5 in a row at most).
 *
 *  - a claim lock (2026-11-18): a final text that claims a pass or hands over a push command is blocked while the
 *    code is unverified, failed or pending, also on a second stop, while a helper or a background check runs, and
 *    after a declared probe (5 in a row at most; see claimBlock). A text that claims nothing keeps the old exits.
 *
 *  - one block per unverified change (2026-11-19): the gate remembers the change it blocked. A later stop with
 *    the same unverified change only warns (the claim lock still holds a pass claim or a push command). A new
 *    edit or a new failure blocks once again. No memory (it cannot be read or written): block as before.
 *  - a block reason of this file ends with its rule id in round brackets: (SG-UNVERIFIED), (SG-FAILED),
 *    (SG-PENDING), (SG-CLAIM), (SG-GO-ON). The guard report counts blocks by these ids. The open-notes list ends with its id
 *    (SG-NOTES); review-notes.test.mjs pins the end of that text. It is known by its first words, and when it
 *    joins another block it comes after that block's id.
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
var claimHeld = false; // this stop was held by the claim lock (see claimBlock)
// Open reviewer notes (2026-11-12, rule 5): notesBlock turns this stop into a block (joined to any other
// block reason); notesWarn is only a warning (the runaway guard, or an older host's repeated stop).
var notesBlock = '', notesWarn = '';
var goOnBlock = ''; // set below, after the scan: only note answers in the final text
function markIdle() {
  // A stop the claim lock did not hold ends its 5-in-a-row count.
  if (!claimHeld) { try { notesBlockCount(() => 0, '#claim'); } catch (e) { /* no count to clear */ } }
  try { if (lastScan) require('./lib/timer-idle.cjs').sideReviews(input, lastScan); } catch (e) { /* the timer never blocks a stop */ }
  try { if (lastScan) require('./lib/timer-idle.cjs').autoEnd(input, lastScan); } catch (e) { /* the timer never blocks a stop */ }
  // Busy: a check or helper of the work still runs, whichever verdict this stop gets (lastScan.workRunning).
  try { require('./lib/timer-idle.cjs').idle(input, undefined, { busy: stopBusy || !!(lastScan && lastScan.workRunning) }); } catch (e) { /* the timer never blocks a stop */ }
}
function out(obj) {
  if (notesBlock) obj = obj && obj.decision === 'block' ? { ...obj, reason: obj.reason + '\n\n' + notesBlock } : { decision: 'block', reason: notesBlock };
  else if (notesWarn && !(obj && obj.decision === 'block')) obj = { ...(obj || {}), systemMessage: (obj && obj.systemMessage ? obj.systemMessage + '\n' : '') + notesWarn };
  // Only note answers in the final text: the stop is held once with the next step (see goOnBlock below).
  if (goOnBlock && !(obj && obj.decision === 'block')) obj = { decision: 'block', reason: goOnBlock + (obj && obj.systemMessage ? '\n\n' + obj.systemMessage : '') };
  if (!obj || obj.decision !== 'block') markIdle();
  process.stdout.write(JSON.stringify(obj)); process.exit(0);
}
function allow() { if (notesBlock || notesWarn || goOnBlock) out({}); markIdle(); process.exit(0); }

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

// Rule 5 as a lock (2026-11-12): the author dropped three reviewer notes without showing them to the
// user. While a reviewer note has no outcome, a final text that says `REVIEW: PASS` / `GATE: PASS`, or
// hands over a push command in a code block, is blocked with the open notes. Other stops are untouched;
// with no reviewer report in the session there are no notes. Any error: no lock.
//  - The host sends the final text (last_assistant_message). Its own `NOTE n: …` lines count at once:
//    the transcript may not hold it yet (follow-up C). The lock then holds on every such stop, also a
//    repeated one, so the author cannot get past it by saying PASS twice (follow-up B); the way out is to
//    answer the notes, or to stop with a question to the user and no verdict or push command.
//  - Runaway guard: after 5 such blocks in a row in one session the 6th only warns and the count starts
//    again; any stop that passes this check clears the count. A count that cannot be kept (no state
//    folder for this transcript) falls back to the older rule below.
//  - Without the final text (an older host), this turn's own verdict lines decide: block once, then warn.
// Why the limit stays at 5 (2026-11-18): a push command now counts anywhere in the final text, even in plain words
// or a quote, so a false alarm is possible (a text that only talks about `git push`). A stop hook that can never
// end would lock the session on such a false alarm, so the 6th stop in a row only warns and the count restarts.
const NOTES_BLOCKS_FILE = 'review-notes-blocks.json', NOTES_BLOCKS_MAX = 5;
// update(count) gives the new count; returns the count read, or null when it cannot be kept.
// suffix: another count in the same file, for the same session (the claim lock below uses '#claim').
function notesBlockCount(update, suffix = '') {
  try {
    if (!scan.stateAllowed(transcriptPath)) return null;
    const file = path.join(scan.stateFolder(), NOTES_BLOCKS_FILE);
    const key = String(input.session_id || transcriptPath).toLowerCase() + suffix;
    let counts = {};
    try { counts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { counts = {}; }
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) counts = {};
    const count = Number.isInteger(counts[key]) && counts[key] > 0 ? counts[key] : 0;
    const next = update(count);
    if (next !== count) {
      if (next > 0) counts[key] = next; else delete counts[key];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(counts));
    }
    return count;
  } catch (e) { return null; }
}
try {
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
  const open = last !== null ? scan.openNotesAfter(r, last) : (Array.isArray(r.openReviewNotes) ? r.openReviewNotes : []);
  const said = open.length > 0 && (last !== null ? scan.claimsReview(last) : r.turnClaim === true);
  if (said) {
    const list = scan.openNotesMessage(open);
    let hold = !input.stop_hook_active;
    if (last !== null) {
      const count = notesBlockCount((n) => (n >= NOTES_BLOCKS_MAX ? 0 : n + 1));
      if (count !== null) hold = count < NOTES_BLOCKS_MAX;
    }
    if (hold) notesBlock = list; else notesWarn = '⛔ ' + list;
  } else {
    notesBlockCount(() => 0);
  }
} catch (e) { notesBlock = ''; notesWarn = ''; }

// Go on after note answers (2026-11-25, owner; test 4 stopped three times). The NOTE lines go in a message with no
// tool call, so that message ends the turn and the author waited for "go on". When the final text holds only note
// answers the guards accept (transcript-scan.js noteAnswersOnly), a step is still due: the review re-check, the
// verdict, the gate or the ship brief. This stop is then held once, with the way on. The gate does not run
// sanad.mjs itself (14 s a run, the hook has 20 s): the author runs it and does the step it prints. One time per
// stop: the gate keeps the text it held (a hash, key '#goon' in the count file of the notes lock) and never holds
// the same text twice. It does not read stop_hook_active: that stays true for the rest of a turn after any block
// (an SG-NOTES or SG-UNVERIFIED block before the answers), which would switch this rule off (review fix 2026-11-25).
// With no state folder it falls back to stop_hook_active. A stop another rule blocks keeps that block alone.
// Any error: no hold.
function goOnFirstTime(text) {
  const hash = require('crypto').createHash('sha1').update(String(text).replace(/\r/g, '').trim()).digest('hex');
  let first = !input.stop_hook_active;
  notesBlockCount((n) => { first = n !== goOnMark(hash); return goOnMark(hash); }, '#goon');
  return first;
}
// The count file keeps whole numbers: the text's hash as one (its first 12 hex digits), never 0.
function goOnMark(hash) { return parseInt(hash.slice(0, 12), 16) || 1; }
try {
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
  if (last !== null && typeof scan.noteAnswersOnly === 'function' && scan.noteAnswersOnly(r, last) && goOnFirstTime(last)) {
    const next = path.join(__dirname, '..', 'skills', 'gate', 'scripts', 'sanad.mjs').replace(/\\/g, '/');
    const repo = String(input.cwd || r.reviewCwd || '').replace(/\\/g, '/');
    goOnBlock = 'Your last message held only note answers, and the task is not done: do not wait for the user. ' +
      'Run `node ' + next + ' next' + (repo ? ' --repo "' + repo + '"' : '') + '` and do the step it prints (the re-check after a fix, the verdict, the gate or the ship brief). ' +
      'If it prints that nothing is due, send the ship brief. (SG-GO-ON)';
  }
} catch (e) { goOnBlock = ''; }

// The claim lock (2026-11-18, stop gate promise, finding 3). The notes lock above holds a final text that claims a
// pass while a reviewer note is open. The same final text, claiming a pass (`REVIEW: PASS` / `GATE: PASS`) or handing
// over a push command, is also held while the code is unverified: failed, pending, or a helper or background check
// still running. Before, such a text passed on the second stop, while a helper ran, or after a declared probe, and the
// user pushes by hand from the command. It uses the same 5-in-a-row count as the notes lock (a second count, key
// '#claim', in the same file); any stop that is not held clears it. A final text that claims nothing keeps the old
// exits. Without the host's final text (an older host), this turn's own claim holds once, then warns. Any error: no lock.
function claimBlock(why) {
  try {
    const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
    const claims = last !== null ? scan.claimsReview(last) : r.turnClaim === true;
    if (!claims) return;
    let hold = !input.stop_hook_active;
    if (last !== null) {
      const count = notesBlockCount((n) => (n >= NOTES_BLOCKS_MAX ? 0 : n + 1), '#claim');
      if (count !== null) hold = count < NOTES_BLOCKS_MAX;
    }
    if (!hold) return;
    claimHeld = true;
    out({
      decision: 'block',
      reason: 'The final text claims a pass (REVIEW/GATE: PASS) or hands over a push command, but ' + why + '. ' +
        'Do not claim a pass or hand over a push command yet: get the build/test to pass on the final code first, then say it. ' +
        'To report where things stand without a claim, send a text with no verdict line and no push command. (SG-CLAIM)',
    });
  } catch (e) { /* the lock is an extra; the stop goes on */ }
}

/* ---------------------------------------------------------------------------
 * Verdict — exactly one of six exits (open reviewer notes, above, turn any of them into a block):
 *   1. no code edit this session               → allow silently
 *   2. PASSING verify ran after the last edit  → allow + confirmation note
 *      (or a red-proof green run passed there, though the proof failed: allow + that note)
 *   3. a helper or a background check of this
 *      work still running, nothing failed      → allow + wait note (its finish returns here)
 *   4. unverified, already blocked once        → allow + warning (never loop)
 *   5. last verify after the edit FAILED       → block ONCE: fix, re-run
 *   6. no verify at all since the last edit    → block ONCE: run the gate
 * ------------------------------------------------------------------------- */

// The review record (2026-11-18, audit finding 2). A normal review verdict accepted here (a completed reviewer
// run after the last change, `REVIEW: PASS` not "reused", no open note) puts the commits of HEAD on record, so
// a later "reused" verdict can rest on it. The user usually pushes by hand, so the stop is the reliable point;
// the push guard writes the same record. Writing twice changes nothing; any error writes nothing.
try {
  const store = require(path.join(__dirname, 'lib', 'review-store.cjs'));
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
  // 2026-11-18 (repair round): only the folder the reviewed change lives in is recorded, only at the stop that holds the
  // verdict; a later stop adds a HEAD of the same tree and base; a FAIL or an open note withdraws (see review-store.cjs).
  store.atStop(transcriptPath, r, last, input.cwd || process.cwd(), input.session_id);
} catch (e) { /* the record is an extra; the gate goes on */ }

if (r.lastEdit === -1) allow();

// Same-tree memo. A git switch/pull/merge counts as a change, but when the
// folder it changed is clean and its tree is byte-identical to a tree a passing
// source-bound evidence check verified, nothing new exists to verify. A tree id
// names the content, so the same tree in another worktree or clone is the same
// code (2026-11-05: a checkout of the tested commit in the main folder kept
// asking for a rerun). Any git error → no memo.
// raw: the output as git wrote it (a `-z` list, whose first line may start with a space).
function gitRead(args, cwd, timeout = 8000, raw = false) {
  try {
    const text = require('child_process').execFileSync('git', args, { cwd: cwd || input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.min(8000, timeout), windowsHide: true });
    return raw ? text : text.trim();
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
// Remote-tip memo (2026-11-14). Git syncs (switch, pull, merge, reset, checkout) after every other change,
// each folder left clean (no staged, unstaged or untracked file) with HEAD's tree equal to a remote branch
// tip's tree, only brought in upstream code: nothing of this session's own to verify (a clean
// `git switch -q main && git pull -q` asked for a build). A fetched-ref move there needs a clean folder,
// as above. A merge with local commits, a local-only branch or a dirty folder matches no tip. Any git
// error, an unknown folder or the time budget spent → no memo (the stop hook has 20 s in all).
// Clean means clean of code (2026-11-17): the folder is judged at the stop, and a prose file edited after
// the sync (README.md, which obliges no check) made it dirty, so the earlier switch read as a change. A
// changed, staged, deleted, renamed or new file counts only when it is a code file: the rule for edits,
// applied to its name inside the repository, wherever the repository is. A submodule, or a folder git
// reports whole (a repository inside it), is never prose. A line of a kind not known here → not clean.
const SYNC_BUDGET_MS = 5000;
const STATUS_FIELDS = new Map([['1', 8], ['2', 9], ['u', 10], ['?', 1]]);   // git status --porcelain=v2: the fields before the name
function cleanOfCode(dir, read) {
  const text = read(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'], dir, true);
  if (text === null) return false;
  const lines = text.split('\0');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].startsWith('# ')) continue;                  // a header line (`# stash <n>` with status.showStash)
    const fields = lines[i].split(' ');
    const before = STATUS_FIELDS.get(fields[0]);
    if (!before || fields.length <= before) return false;
    if (before > 1 && fields[2] !== 'N...') return false;                  // a submodule
    const names = [fields.slice(before).join(' ')];
    if (fields[0] === '2') names.push(lines[++i] || '');                   // a rename or copy: the old name follows
    if (names.some((name) => !name || /[\\/]$/.test(name) || scan.isCodePath('repo/' + name))) return false;
  }
  return true;
}
function syncedToRemoteTips() {
  // An unexpected error keeps the old rule (the sync counts as a change), never a silent allow (2026-11-14).
  try { return syncsAtRemoteTips(); } catch (e) { return false; }
}
function syncsAtRemoteTips() {
  const moves = Array.isArray(r.syncMoves) ? r.syncMoves : [];
  if (!/^<git(?:-remote)?>$/.test(r.lastEditPath) || !moves.length) return false;
  const deadline = Date.now() + SYNC_BUDGET_MS;
  const read = (args, dir, raw) => { const left = deadline - Date.now(); return left > 0 ? gitRead(args, dir, left, raw) : null; };
  const folders = new Map();   // folder -> a move there was not to a fetched ref, so it must be at a remote tip
  for (const m of moves) {
    if (!m || typeof m.repo !== 'string' || !m.repo) return false;
    folders.set(m.repo, folders.get(m.repo) === true || m.remote !== true);
  }
  for (const [dir, needsTip] of folders) {
    if (!cleanOfCode(dir, read)) return false;
    if (!needsTip) continue;
    const tree = read(['rev-parse', '--verify', '-q', 'HEAD^{tree}'], dir);
    if (!tree || !/^[0-9a-f]{40,64}$/i.test(tree)) return false;
    const tips = read(['for-each-ref', '--format=%(tree)', 'refs/remotes'], dir);
    if (!tips || !tips.split(/\r?\n/).includes(tree)) return false;
  }
  return true;
}
const remoteOnly = remoteRefsOnly();
if (remoteOnly && (r.lastNonRemoteEdit ?? -1) === -1) allow();             // no code change of its own this session
const treeVerified = !remoteOnly && r.lastEditPath === '<git>' && verifiedTreeCheckedOut();
let lastEdit = remoteOnly ? r.lastNonRemoteEdit : treeVerified ? r.lastNonGitEdit : r.lastEdit;
// Checked only when it can move the last change earlier than the memos above did.
const synced = typeof r.lastNonSyncEdit === 'number' && r.lastNonSyncEdit < lastEdit && syncedToRemoteTips();
if (synced && r.lastNonSyncEdit === -1) allow();                            // no code change of its own this session
if (synced) lastEdit = r.lastNonSyncEdit;
const memo = synced ? ' The last change only synced clean folders to remote branch tips, so it needs no rerun.'
  : treeVerified ? ' The checked-out tree is identical to one a passing evidence check verified (' + verifiedTree.slice(0, 12) + '), so the git-only change needs no rerun.'
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
// A red-proof run whose green run passed on the tree after the last edit, while the proof itself failed (NOT
// RED, a break not caught): the tests ran green, so no test run is missing (2026-11-15). The push guard still
// counts the failed proof (see transcript-scan.js "Red-proof runs").
if (!failedAfterEdit && !pendingAfterEdit && (r.lastGreenProof ?? -1) > lastEdit) {
  out({ systemMessage: 'The tests ran green after the last code edit (a red-proof green run), but the proof itself did not hold (NOT RED, or a break not caught or invalid: see its RED-PROOF line).' + memo + ' Fix the tests and prove again: the push guard still counts the failed proof.' });
}
if (!failedAfterEdit && !pendingAfterEdit && r.lastProbeFailure > lastEdit) {
  claimBlock('the last build/test after your code edit failed (a declared probe), so nothing here passed');
  out({ systemMessage: 'Declared review probe(s) failed as expected. That is evidence about the code under review, not verification of your own change; the push guard still refuses while they fail.' });
}
// A helper agent of the current work is still working (launched after the last passing check, even
// before the change, as a Test designer is): the task goes on when it reports, so the stop waits for
// it instead of asking for a check that cannot run yet (2026-11-06). Its finish brings the next stop
// back to this gate. A helper launched before a later passing check belongs to older work.
if (!failedAfterEdit && !pendingAfterEdit && (r.lastRunningHelper ?? -1) > r.lastVerify) {
  claimBlock('a helper for this work is still running and the code is not verified yet');
  stopBusy = true;
  out({ systemMessage: 'A helper for this work is still running; the build/test check follows when its result is in.' });
}

// The check that blocks, named, so it is found at once (2026-11-06: hunting an unnamed one cost ~20 min).
function shown(command) { const c = String(command || '').replace(/\s+/g, ' ').trim(); return c ? (c.length > 160 ? c.slice(0, 157) + '…' : c) : 'unknown'; }
// The edit that is owed, named too. Once the syncs after it are credited (the remote-tip memo), the owed edit
// is an earlier one: blaming the git change there sent the author after the wrong cause (2026-11-17).
const owed = synced ? String(r.lastNonSyncEditPath || '') : lastEdit === r.lastNonSyncEdit ? String(r.lastNonSyncEditPath || r.lastEditPath || '') : r.lastEditPath;
const file = /^<git(?:-remote)?>$/.test(owed) ? ' (last change: a git merge/reset/switch/stash)' : owed && owed !== '<generated>' ? ' (last edit: ' + path.basename(owed) + ')' : '';

// A live background check of the current work, and nothing failed: its finish notice brings the next
// stop back to this gate, so the stop waits instead of blocking. Blocking here only made every status
// reply during a remote suite repeat "still running" (2026-11-07). It is still not a passing result.
// A run no notice can bring back (finished without an exit code, or no task id) still blocks.
const stuckAfterEdit = (r.lastStuckVerifyStop ?? -1) > lastEdit;
if (!failedAfterEdit && pendingAfterEdit && !stuckAfterEdit) {
  claimBlock('a build/test for this work is still running in the background and has not passed yet');
  stopBusy = true;
  out({ systemMessage: 'A build/test for this work is still running in the background: `' + shown(r.lastPendingVerifyStopCommand) + '`. Not verified yet; this check runs again when it finishes.' });
}

// The exit of a stop that is not blocked again: the claim lock first, then the warning.
function warnUnverified() {
  claimBlock(failedAfterEdit ? 'the last build/test after your code edit failed' : pendingAfterEdit ? 'a verification command\'s result was never collected' : 'code changed after the last passing build/test');
  out({
    systemMessage: failedAfterEdit
      ? '⛔ Gate NOT verified: the last build/test after your code edit FAILED. Run /gate before shipping.'
      : pendingAfterEdit ? '⛔ Gate NOT verified: a verification command\'s result was never collected. Collect it or rerun the check before shipping.'
      : '⛔ Gate NOT verified: code changed after the last passing build/test. Run /gate before shipping.',
  });
}
if (input.stop_hook_active) warnUnverified();

// One block per unverified change (2026-11-19). The block below came back on every new stop while the same
// change stayed unverified: 21 identical blocks hit question turns in one day. The gate now remembers the
// change it blocked: the session, the transcript, the last edit's number and file, the state (failed, pending
// or none) and that check's number and command. The memory is kept in the count file of the notes lock, under
// a third suffix ('#once'). The same change again takes the exit above: the claim lock still holds a pass claim
// or a push command, any other text passes with the warning. A new edit, a new failed run or a new lost check
// is another change and blocks once again.
// The memory can never open the gate by mistake: a file that cannot be read or written, a broken entry, or a
// transcript with no state folder (a test transcript) gives no memory, and the gate blocks as before.
const ONCE_SUFFIX = '#once', ONCE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
function onceKey() { return String(input.session_id || transcriptPath).toLowerCase() + ONCE_SUFFIX; }
// The unverified change as one text; any difference is another change. '' when it has no number to name it.
function unverifiedChange() {
  const state = failedAfterEdit ? 'failed' : pendingAfterEdit ? 'pending' : 'none';
  const check = failedAfterEdit ? [r.lastFailedVerifyStop ?? r.lastFailedVerify, r.lastFailedVerifyStopCommand]
    : pendingAfterEdit ? [r.lastStuckVerifyStop, r.lastStuckVerifyStopCommand] : [-1, ''];
  if (!Number.isFinite(lastEdit) || !Number.isFinite(check[0])) return '';   // a number may hold a fraction (10.001)
  return JSON.stringify([path.resolve(transcriptPath).toLowerCase(), lastEdit, String(owed || ''), state, check[0], String(check[1] || '')]);
}
// True only when this session was already blocked for exactly this change.
function blockedBefore(change) {
  try {
    if (!change || typeof scan.claimsReview !== 'function' || !scan.stateAllowed(transcriptPath)) return false;
    const kept = JSON.parse(fs.readFileSync(path.join(scan.stateFolder(), NOTES_BLOCKS_FILE), 'utf8'))[onceKey()];
    return !!kept && typeof kept === 'object' && kept.change === change;
  } catch (e) { return false; }
}
// Keeps the change this stop is blocked for. Any error keeps nothing, so the next stop blocks again.
function rememberBlock(change) {
  try {
    if (!change || !scan.stateAllowed(transcriptPath)) return;
    const stateFile = path.join(scan.stateFolder(), NOTES_BLOCKS_FILE), now = Date.now();
    let all = {};
    try { all = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { all = {}; }
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    // The memory of a session that ended long ago is dropped, so the file stays small.
    for (const k of Object.keys(all)) if (k.endsWith(ONCE_SUFFIX) && !(all[k] && now - all[k].at < ONCE_KEEP_MS)) delete all[k];
    all[onceKey()] = { change, at: now };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(all));
  } catch (e) { /* no memory: the next stop blocks again */ }
}
const change = unverifiedChange();
// A stop that claims a pass or hands over a push command never uses the memory: it takes the main block every time.
function claimsNow() {
  try {
    const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
    return text !== null ? scan.claimsReview(text) : r.turnClaim === true;
  } catch (e) { return true; }
}
if (!claimsNow() && blockedBefore(change)) warnUnverified();
rememberBlock(change);

out({
  decision: 'block',
  reason: failedAfterEdit
    ? 'The last build/test run after your code edit FAILED' + file + ' — a failing run is not verification. ' +
      'Fix the cause, re-run the build and the relevant tests, quote their real output, then stop again. ' +
      'If it genuinely cannot pass here, say exactly what is failing and why instead of claiming success. ' +
      'The failed check: `' + shown(r.lastFailedVerifyStopCommand) + '`. ' +
      'If every failure is a timeout under machine load (not the code), rerun only the failed tests; to clear this run, send this line alone in a text-only message, with your rerun command filled in, then run that command exactly, which must pass: ' +
      // The rule id goes on its own last line here: the CHECK RETIRED line must stay alone on its line.
      'CHECK RETIRED: ' + JSON.stringify({ failed: r.lastFailedVerifyStopCommand || '<the failed command>', replacement: '<the rerun command>', reason: '<why>' }) + '\n(SG-FAILED)'
    : pendingAfterEdit ? 'A build/test finished or was launched but its result was never collected' + file + ': `' + shown(r.lastStuckVerifyStopCommand) + '`. Read its TaskOutput, or rerun it in the foreground, fix any failure, then run /gate. Starting a background command is not a passing result. (SG-PENDING)'
    : 'Code files were edited this session' + file + ' but no build/test has run since the last edit. ' +
      'Apply the Definition-of-Done at the cheapest correct rung (CLAUDE.md "Verify fast"): run the build and the relevant tests now, quote their real output, then stop again. ' +
      'If verification is genuinely impossible here (no toolchain, needs the user), say exactly what is unverified and why instead of claiming success. (SG-UNVERIFIED)',
});
