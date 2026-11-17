import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-17 (audits 3 and 4 + user decision): how a reviewer note may be closed.
// A: "fixed" needs a code edit and a passing check after the note's report. B: a FAIL report with no readable
// finding adds one Blocker. C: "refuted" closes a note only after a note checker's REFUTED line (never a Blocker).
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realRequire = createRequire(import.meta.url);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-notes-closure-')));
const stateDir = path.join(root, 'state');
process.env.SANAD_STATE_DIR = stateDir;
const SINCE = '2026-01-01T00:00:00.000Z';
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), SINCE + '\n');
const scan = realRequire(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = 'C:/repos/example';
const at = (n) => new Date(Date.UTC(2026, 10, 17, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, isError = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], n, toolUseResult ? { toolUseResult } : {});
const shell = (id, command, content, n, isError = false) => [call(id, 'Bash', { command }, n), result(id, content, n, isError)];
const say = (text, n) => msg('assistant', [{ type: 'text', text }], n);
const lines = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:';
const handBack = (id, report, n) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true,
  origin: { kind: 'peer', from: id, senderTaskId: id, name: 'x' },
  prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n' + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>' } });
const notice = (id, n, report) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n<result>' + report + '</result>\n</task-notification>' } });
const launch = (id, n, input) => [call(id + '-call', 'Agent', { description: 'x', run_in_background: true, ...input }, n),
  result(id + '-call', 'Async agent launched successfully.', n, false, { isAsync: true, status: 'async_launched', agentId: id })];
const run = (id, n, input, report) => [...launch(id, n, input), handBack(id, report, n + 1), notice(id, n + 1, report)];
const REVIEWER = { subagent_type: 'independent-reviewer', prompt: 'You are the independent reviewer (read-only). Review the diff.' };
const CHECKER = () => ({ subagent_type: 'braintrust-expert-sonnet', prompt: 'Seat: Note check. Try to refute each open note. Read-only.' });
const GAP = 'RECOMMEND: FAIL\n- Gap — Upload.cs:9 — the error text is not translated';
const BLOCKER = 'RECOMMEND: FAIL\n- Blocker — Upload.cs:9 — a teacher can read any file';
let k = 0;
const edit = (n) => { k++; return [call('e' + k, 'Edit', { file_path: repo + '/src/App.cs' }, n), result('e' + k, 'File updated.', n)]; };
const pass = (n) => { k++; return shell('t' + k, 'dotnet test', 'Passed!  - Failed:     0, Passed:     3', n); };
const failRun = (n) => { k++; return shell('f' + k, 'dotnet test', 'Failed!  - Failed:     1, Passed:     2', n, true); };
const FIXED = 'NOTE 1: fixed — added the AR/EN key and UploadTests.TooBig_ShowsText';
let files = 0;
function write(entries) { const f = path.join(root, 't' + (++files) + '.jsonl'); fs.writeFileSync(f, lines(entries)); return f; }
const scanOf = (entries) => scan.scanTranscript(write(entries));
function fullScan(file) {
  const saved = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = fs.mkdtempSync(path.join(root, 'fresh-'));
  fs.writeFileSync(path.join(process.env.SANAD_STATE_DIR, 'review-notes-since'), SINCE + '\n');
  try { return scan.scanTranscript(file); } finally { process.env.SANAD_STATE_DIR = saved; }
}
const outcomes = (r) => r.reviewNotes.map((n) => n.outcome);

test('A: a fixed line closes a note only after an edit and a passing check that follow its report', () => {
  const rep = run('rv1', 1, REVIEWER, GAP);
  const none = scanOf([...rep, say(FIXED, 5)]);
  assert.deepEqual(outcomes(none), [null]);
  assert.match(none.reviewNotes[0].problem, /needs a code change and a passing test after the note/);
  assert.deepEqual(outcomes(scanOf([...rep, ...edit(4), say(FIXED, 6)])), [null], 'an edit with no check');
  assert.deepEqual(outcomes(scanOf([...rep, ...edit(4), ...failRun(5), say(FIXED, 6)])), [null], 'a failed check');
  assert.deepEqual(outcomes(scanOf([...rep, ...pass(4), ...edit(5), say(FIXED, 6)])), [null], 'a check before the edit');
  assert.deepEqual(outcomes(scanOf([...rep, ...edit(4), ...pass(5), say(FIXED, 6)])), ['fixed']);
  assert.deepEqual(outcomes(scanOf([...edit(0), ...pass(0), ...rep, say(FIXED, 6)])), [null], 'a change before the report does not count');
  assert.deepEqual(outcomes(scanOf([say(FIXED, 0), ...rep, ...edit(4), ...pass(5)])), [null], 'fixed before its report existed');
});

test('A: the final text of the stop is judged the same way (openNotesAfter)', () => {
  const rep = run('rv1', 1, REVIEWER, GAP);
  assert.equal(scan.openNotesAfter(scanOf(rep), FIXED).length, 1);
  assert.equal(scan.openNotesAfter(scanOf([...rep, ...edit(4), ...pass(5)]), FIXED).length, 0);
});

test('B: a FAIL report with no readable finding adds one Blocker; a PASS report adds none', () => {
  const unreadable = 'RECOMMEND: FAIL\n\n[P1] High: closure trusts any claim\nThe guard accepts it.';
  const r = scanOf(run('rv1', 1, REVIEWER, unreadable));
  assert.deepEqual(r.reviewNotes.map((n) => n.kind), ['Blocker']);
  assert.match(r.reviewNotes[0].text, /the reviewer said FAIL but no finding line could be read/);
  assert.equal(scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: PASS\n\nNothing found.')).reviewNotes.length, 0);
  assert.deepEqual(scanOf(run('rv1', 1, REVIEWER, GAP)).reviewNotes.map((n) => n.kind), ['Gap'], 'a readable finding adds no extra Blocker');
});

test('C: refuted closes a note only after a note checker refuted it; never a Blocker', () => {
  const REF = 'NOTE 1: refuted — the checker showed the key exists at ar.json:12';
  const gap = run('rv1', 1, REVIEWER, GAP);
  const checker = run('nc1', 4, CHECKER(), 'CONFIRMED 2 — a real one\n- **REFUTED 1** — ar.json:12 already holds upload.errorTooBig, so the text is translated');
  const r = scanOf([...gap, ...checker, say(REF, 8)]);
  assert.deepEqual(outcomes(r), ['refuted']);
  assert.deepEqual(r.refutedNotes, [{ n: 1, kind: 'Gap', text: r.reviewNotes[0].text, evidence: 'ar.json:12 already holds upload.errorTooBig, so the text is translated' }]);
  assert.equal(r.reviewNotes.length, 1, 'the checker report adds no note');
  const none = scanOf([...gap, say(REF, 8)]);
  assert.deepEqual(outcomes(none), [null]);
  assert.match(none.reviewNotes[0].problem, /only a note the note check refuted/);
  assert.deepEqual(outcomes(scanOf([...gap, ...run('nc1', 4, CHECKER(), 'REFUTED 2 — something else entirely here'), say(REF, 8)])), [null], 'another number');
  assert.deepEqual(outcomes(scanOf([...gap, ...run('nc1', 4, CHECKER(), 'REFUTED 1 — short'), say(REF, 8)])), [null], 'evidence under 12 characters');
  const blocker = scanOf([...run('rv1', 1, REVIEWER, BLOCKER), ...run('nc1', 4, CHECKER(), 'REFUTED 1 — Upload.cs:9 the checker believes it is wrong here'), say(REF, 8)]);
  assert.deepEqual(outcomes(blocker), [null], 'a Blocker is never refuted');
  assert.deepEqual(blocker.refutedNotes, []);
});

test('C: a checker launched before the note does not count, and a checker report alone adds no note', () => {
  const REF = 'NOTE 1: refuted — Upload.cs:9 the checker believes it is wrong here';
  // the checker starts at 1, the reviewer writes the note at 2, the checker's report arrives at 6
  const early = [...launch('nc1', 1, CHECKER()), ...run('rv1', 2, REVIEWER, GAP), handBack('nc1', 'REFUTED 1 — Upload.cs:9 the checker believes it is wrong here', 6), say(REF, 8)];
  assert.deepEqual(outcomes(scanOf(early)), [null]);
  assert.deepEqual(scanOf(run('nc1', 1, CHECKER(), 'REFUTED 1 — Upload.cs:9 the checker believes it is wrong here')).reviewNotes, []);
});

const REFV = 'NOTE 1: refuted — ar.json:12 already holds the key';
const checked = (report, extra = {}) => scanOf([...run('rv1', 1, REVIEWER, GAP), ...run('nc1', 4, { ...CHECKER(), ...extra }, report), say(REFV, 8)]);

test('C: a K number is not a note number, and evidence needs a file and line', () => {
  assert.deepEqual(outcomes(checked('BRIEF 3f2a\nREFUTED K1 — ar.json:12 already holds upload.errorTooBig, so the text is translated')), [null]);
  assert.deepEqual(outcomes(checked('REFUTED 1 — ............')), [null]);
  assert.deepEqual(outcomes(checked('REFUTED 1 — I believe this is not a real issue')), [null]);
});

test('C: the answer shapes the note-check helper accepts are accepted', () => {
  for (const line of ['`REFUTED 1 - tests/roles.test.ts:88 already saves a user with two roles`', 'REFUTED: 1 — src/queue.ts:44 takes the row with a guarded UPDATE',
    'REFUTED `1` — src/queue.ts:44 takes the row with a guarded UPDATE', '### REFUTED 1 — src/queue.ts:44 takes the row']) {
    assert.deepEqual(outcomes(checked(line)), ['refuted'], line);
  }
});

test('C: a hand-written checker prompt is still a checker, whatever its agent type', () => {
  const ok = 'REFUTED 1 — ar.json:12 already holds upload.errorTooBig, so the text is translated';
  assert.deepEqual(outcomes(checked(ok, { prompt: 'Seat: Note check before any fix. Read the brief' })), ['refuted']);
  assert.deepEqual(outcomes(checked(ok, { subagent_type: 'general-purpose', prompt: 'Seat: Note check, before any fix.' })), ['refuted']);
});

test('A: a git move or a formatter run is not the code edit', () => {
  const rep = run('rv1', 1, REVIEWER, GAP);
  for (const cmd of ['git pull', 'git checkout -b fix/notes', 'git switch -c x', 'git stash', 'git merge origin/staging', 'npx prettier --write src/a.ts', 'dotnet csharpier .']) {
    k++;
    assert.deepEqual(outcomes(scanOf([...rep, ...shell('g' + k, cmd, 'ok', 4), ...pass(5), say(FIXED, 6)])), [null], cmd);
  }
});

test('B: more FAIL verdict shapes, a side line, a BOM, and one Blocker per report', () => {
  const body = '\n\n[P1] High: closure trusts any claim\nThe guard accepts it.';
  for (const head of ['1. RECOMMEND: FAIL', '**RECOMMEND:** FAIL', 'RECOMMEND: **FAIL**', '## RECOMMEND: FAIL', '> RECOMMEND: FAIL', '`RECOMMEND: FAIL`', '1) RECOMMEND: FAIL']) {
    assert.deepEqual(scanOf(run('rv1', 1, REVIEWER, head + body)).reviewNotes.map((n) => n.kind), ['Blocker'], head);
  }
  const side = scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n\n[P1] High: a teacher can read any file (Upload.cs:9)\n\nEXTRA TEST: a 403 case for the other teacher'));
  assert.ok(side.reviewNotes.some((n) => n.kind === 'Blocker'), 'a side line does not hide the unreadable finding');
  const q = scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n\n[P1] a\n[P2] b\n\nShip with these open or not: you decide.'));
  assert.ok(q.reviewNotes.some((n) => n.kind === 'Blocker'));
  const rep = 'RECOMMEND: FAIL' + body;
  const base = run('rv1', 1, REVIEWER, 'RECOMMEND: PASS');
  const show = (id, text, n) => shell(id, 'cat codex-review.md', text, n);
  const bom = scanOf([...base, ...show('c1', '\uFEFFRECOMMEND: FAIL\n- Bug — Upload.cs:9 — a teacher can read any file', 5)]);
  assert.deepEqual(bom.reviewNotes.map((n) => n.kind), ['Bug']);
  const twice = scanOf([...base, ...show('c1', rep, 5), ...show('c2', rep + '\n', 6)]);
  assert.deepEqual(twice.reviewNotes.map((n) => n.kind), ['Blocker']);
});

test('C: an incremental scan equals a from-zero scan across the closure steps', () => {
  const steps = [
    run('rv1', 1, REVIEWER, GAP),
    [...run('nc1', 4, CHECKER(), 'REFUTED 1 — ar.json:12 already holds upload.errorTooBig, so the text is translated'), ...edit(6), ...pass(7)],
    [say('NOTE 1: refuted — ar.json:12 holds the key', 9)],
  ];
  const file = path.join(root, 'grow.jsonl');
  fs.writeFileSync(file, '');
  for (let i = 0; i < steps.length; i++) {
    fs.appendFileSync(file, lines(steps[i]));
    const inc = scan.scanTranscript(file);
    assert.deepEqual(inc, fullScan(file), 'step ' + (i + 1));
  }
  assert.deepEqual(outcomes(scan.scanTranscript(file)), ['refuted']);
  assert.equal(scan.scanTranscript(file).refutedNotes.length, 1);
});

// 2026-11-17 (audit 2, S1): in a FAIL report a finding-shaped line the guards could not read as a note must not vanish
// beside one readable minor note. Narrow: a severity or priority tag at the start of the line, then text.
const READ_GAP = '- Gap — app.js:2 — fix the stale comment.';
const UNREAD_TEXT = /the report holds 1 line\(s\) the guards could not read as findings/;
test('S1: a FAIL report with one readable note and one unread severity-tagged line adds one Blocker that quotes the line', () => {
  const r = scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n[P1] app.js:1 — every user now passes authorization.\n' + READ_GAP.replace('- ', '')));
  assert.deepEqual(r.reviewNotes.map((n) => n.kind).sort(), ['Blocker', 'Gap']);
  const b = r.reviewNotes.find((n) => n.kind === 'Blocker');
  assert.match(b.text, UNREAD_TEXT);
  assert.ok(b.text.includes('every user now passes authorization'), b.text);
  assert.equal(r.reviewNotes.length, 2);
  const two = scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n' + READ_GAP + '\n[P1] a.js:1 — one\n**High:** b.js:2 two\n- Severity: Critical — c.js:3 three'));
  assert.equal(two.reviewNotes.filter((n) => n.kind === 'Blocker').length, 1, 'once per report');
  assert.match(two.reviewNotes.find((n) => n.kind === 'Blocker').text, /holds 3 line\(s\)/);
});

test('S1: the tags the rule reads, and only at the start of a line', () => {
  for (const line of ['[P0] x.js:1 — bad', 'P2: x.js:1 bad', 'P1 — x.js:1 bad', '- [High] x.js:1 bad', 'High: x.js:1 bad', '**Critical** — x.js:1 bad', 'Major: x.js:1 bad',
    '1. Severe - x.js:1 bad', 'Medium: x.js:1 bad', 'Low: x.js:1 bad', 'Severity: High x.js:1 bad', 'Issue: x.js:1 bad', 'Finding 2: x.js:1 bad', 'Problem — x.js:1 bad',
    'Defect: x.js:1 bad', 'Vulnerability: x.js:1 bad']) {
    const r = scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n' + READ_GAP + '\n' + line));
    assert.ok(r.reviewNotes.some((n) => n.kind === 'Blocker' && UNREAD_TEXT.test(n.text)), line);
  }
});

test('S1: must not change: no extra Blocker for a PASS report, prose, none-lines, headings, fences, continuations, trace lines, questions', () => {
  const quiet = (name, text, kinds = ['Gap']) => assert.deepEqual(scanOf(run('rv1', 1, REVIEWER, text)).reviewNotes.map((n) => n.kind), kinds, name);
  quiet('pass report', 'RECOMMEND: PASS\n' + READ_GAP + '\n[P1] a.js:1 — noted but passing', ['Gap']);
  const cases = {
    prose: 'The high level design is fine and the low risk parts are tidy.',
    noBlocker: 'No Blocker or Bug found in the auth code.',
    bugsNone: 'Bugs: none',
    issuesNone: 'Issues: none',
    heading: '## High risk files\n### Findings',
    fence: '```\n[P1] a.js:1 — an example inside a code block\nHigh: another example\n```',
    continuation: '  High: this evidence line belongs to the Gap above (app.js:2)',
    trace: 'T1 — input empty list → OK (Roles.cs:40)\nT2 — input null → OK (Roles.cs:44)',
    extra: 'EXTRA TEST: a 403 case for the other teacher',
    question: 'Question — app.js:5 — should the limit be 50 or 100?',
  };
  for (const [name, extra] of Object.entries(cases)) {
    const text = 'RECOMMEND: FAIL\n' + READ_GAP + '\n' + extra;
    const kinds = scanOf(run('rv1', 1, REVIEWER, text)).reviewNotes.map((n) => n.kind);
    assert.ok(!kinds.includes('Blocker'), name + ': ' + kinds.join(','));
  }
});

test('S1: the same report twice gives one Blocker; an incremental scan equals a from-zero scan', () => {
  const rep = 'RECOMMEND: FAIL\n[P1] app.js:1 — every user now passes authorization.\n' + READ_GAP;
  const twice = scanOf(run('rv1', 1, REVIEWER, rep).concat(notice('rv1', 4, rep)));
  assert.equal(twice.reviewNotes.filter((n) => n.kind === 'Blocker').length, 1);
  const file = path.join(root, 'grow-unread.jsonl');
  fs.writeFileSync(file, '');
  for (const step of [run('rv1', 1, REVIEWER, rep), [say('ok', 5)], run('rv2', 6, REVIEWER, 'RECOMMEND: FAIL\n[High] b.js:2 — second\n' + READ_GAP + ' again')]) {
    fs.appendFileSync(file, lines(step));
    assert.deepEqual(scan.scanTranscript(file), fullScan(file));
  }
  const r = scan.scanTranscript(file);
  assert.equal(r.reviewNotes.filter((n) => n.kind === 'Blocker').length, 2);
  assert.equal(r.reviewNotes.length, 4);
});

// 2026-11-17 (S2): the checker's last verdict for a note wins while the note is open.
test('S2: a later CONFIRMED or UNSURE for a note withdraws its refutation (same report or a later run)', () => {
  const ev = 'ar.json:12 already holds upload.errorTooBig, so the text is translated';
  const gap = run('rv1', 1, REVIEWER, GAP);
  const take = (...answers) => scanOf([...gap, ...answers.flatMap((a, i) => run('nc' + i, 4 + i * 3, CHECKER(), a)), say(REFV, 20)]);
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev + '\nCONFIRMED 1 — Upload.cs:9 the text is still English')), [null], 'same report, CONFIRMED');
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev + '\n- UNSURE 1 — I could not open ar.json')), [null], 'same report, UNSURE');
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev, 'UNSURE 1 — the file was not readable')), [null], 'a later run');
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev, '**CONFIRMED 1** — Upload.cs:9 still English')), [null], 'a later run, bold');
  assert.match(take('REFUTED 1 — ' + ev + '\nCONFIRMED 1 — Upload.cs:9 real').reviewNotes[0].problem, /only a note the note check refuted/);
  assert.deepEqual(outcomes(take('CONFIRMED 1 — Upload.cs:9 real\nREFUTED 1 — ' + ev)), ['refuted'], 'the last verdict is REFUTED');
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev, 'CONFIRMED 1 — Upload.cs:9 real', 'REFUTED 1 — ' + ev)), ['refuted'], 'refuted again by a later run');
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev + '\nCONFIRMED 2 — Upload.cs:9 another note')), ['refuted'], 'another number does not withdraw');
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev + '\nCONFIRMED 3 files hold it')), ['refuted'], 'prose is no verdict');
});

test('S2: must not change: a note already closed as refuted stays closed after a later CONFIRMED', () => {
  const ev = 'REFUTED 1 — ar.json:12 already holds upload.errorTooBig, so the text is translated';
  const r = scanOf([...run('rv1', 1, REVIEWER, GAP), ...run('nc1', 4, CHECKER(), ev), say(REFV, 8), ...run('nc2', 10, CHECKER(), 'CONFIRMED 1 — Upload.cs:9 real')]);
  assert.deepEqual(outcomes(r), ['refuted']);
});

// 2026-11-17 (repair round): wider verdict spellings, the bare P tag, more tag spellings, label and count lines,
// and one verdict per checker run.
test('S2 repair: the verdict spellings the script reads also withdraw the refutation', () => {
  const ev = 'ar.json:12 already holds upload.errorTooBig, so the text is translated';
  const gap = run('rv1', 1, REVIEWER, GAP);
  const take = (...answers) => scanOf([...gap, ...answers.flatMap((a, i) => run('nc' + i, 4 + i * 3, CHECKER(), a)), say(REFV, 30)]);
  const later = ['**CONFIRMED** 1 — Upload.cs:9 the text is still English', 'CONFIRMED 1', 'CONFIRMED 1.', 'CONFIRMED 1 Upload.cs:9 the text is still English',
    'UNSURE 1 (I could not open ar.json)', 'UNSURE 1, I could not open ar.json', 'CONFIRMED 1 and 2 — both real', 'CONFIRMED 2 and 1 — both real', 'CONFIRMED 1 → Upload.cs:9 real',
    '**UNSURE**: 1 — could not open', 'UNSURE K1 — I could not open ar.json'];
  for (const l of later) {
    assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev + '\n' + l)), [null], 'same report: ' + l);
    assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev, l)), [null], 'later run: ' + l);
  }
  assert.deepEqual(outcomes(take('REFUTED 1 — ' + ev + '\nCONFIRMED 12 — Upload.cs:9 another note')), ['refuted'], 'note 12 is not note 1');
});

test('S2 repair: a second copy of an earlier checker run does not re-arm a refutation a later run withdrew', () => {
  const ev = 'REFUTED 1 — ar.json:12 already holds upload.errorTooBig, so the text is translated';
  const a = run('ncA', 4, CHECKER(), ev);
  const b = run('ncB', 8, CHECKER(), 'CONFIRMED 1 — Upload.cs:9 the text is still English');
  const r = scanOf([...run('rv1', 1, REVIEWER, GAP), a[0], a[1], a[2], ...b, a[3], say(REFV, 30)]);
  assert.deepEqual(outcomes(r), [null]);
});

const underGap = (line) => scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n' + READ_GAP + '\n' + line)).reviewNotes;
test('S1 repair: a place line "P2: ..." is no finding', () => {
  const r = scanOf(run('rv1', 1, REVIEWER, 'RECOMMEND: FAIL\n- Bug — Upload.cs:9 — a null id throws → 500 — check the id\nPlaces checked:\nP2: the none reason holds, it only logs (Service.cs:40)\nP3 · Service.cs · lines 10-20 → OK'));
  assert.deepEqual(r.reviewNotes.map((n) => n.kind), ['Bug']);
});

test('S1 repair: more spellings of a severity or priority tag are counted', () => {
  for (const line of ['### [P1] app.js:1 — every user now passes authorization', '`[P1]` app.js:1 — every user passes', '> [P1] app.js:1 — every user passes', '(P1) app.js:1 — every user passes',
    'P1 app.js:1 every user passes', '[Blocker] app.js:1 — every user passes', 'BLOCKER: app.js:1 every user passes', 'Bug 1: app.js:1 every user passes',
    '\u{1F534} Blocker — app.js:1 — every user passes', 'Critical bug — app.js:1 every user passes', 'High severity: app.js:1 every user passes',
    'Priority: P1 — app.js:1 every user passes', 'Finding #1 (High): app.js:1 every user passes']) {
    const n = underGap(line);
    assert.ok(n.some((x) => x.kind === 'Blocker' && UNREAD_TEXT.test(x.text)), line + ' -> ' + JSON.stringify(n));
  }
});

test('S1 repair: label and count lines are no finding', () => {
  const quiet = (text) => assert.ok(!scanOf(run('rv1', 1, REVIEWER, text)).reviewNotes.some((n) => n.kind === 'Blocker'), text);
  quiet('RECOMMEND: FAIL\nBug — Upload.cs:9 — a null id throws → 500 — check the id\nSeverity: High');
  quiet('RECOMMEND: FAIL\n**Bug — Upload.cs:9**\nProblem: a null id throws.');
  for (const l of ['Findings: 1 Bug, 1 Gap', 'Issues: 0', 'High: 0', 'Findings: _none_', 'Findings: (none besides the Gap above)']) quiet('RECOMMEND: FAIL\n' + READ_GAP + '\n\n' + l);
  // a real finding with a number in it still counts
  assert.ok(underGap('Critical: 3 callers pass an unchecked id (app.js:1)').some((x) => x.kind === 'Blocker'));
});
