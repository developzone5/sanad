import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-18 (audit 3 + user decision): a refutation is the newest independent check of the code as it is now.
// C2: a code or test edit after the checker's launch cancels it. C3: verdicts apply in LAUNCH order, not arrival order.
// C4: a newer CONFIRMED reopens a note closed as refuted. C5: a Question is never refutable.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realRequire = createRequire(import.meta.url);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-notes-binding-')));
const stateDir = path.join(root, 'state');
process.env.SANAD_STATE_DIR = stateDir;
const SINCE = '2026-01-01T00:00:00.000Z';
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), SINCE + '\n');
const scan = realRequire(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = 'C:/repos/example';
const at = (n) => new Date(Date.UTC(2026, 10, 18, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, isError = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], n, toolUseResult ? { toolUseResult } : {});
const shell = (id, command, content, n) => [call(id, 'Bash', { command }, n), result(id, content, n)];
const say = (text, n) => msg('assistant', [{ type: 'text', text }], n);
const userSays = (text, n) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: at(n), origin: { kind: 'human' }, userType: 'external', promptId: 'p' + n });
const lines = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:';
const handBack = (id, report, n) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true,
  origin: { kind: 'peer', from: id, senderTaskId: id, name: 'x' },
  prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n' + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>' } });
const notice = (id, n, report) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n<result>' + report + '</result>\n</task-notification>' } });
const launch = (id, n, input) => [call(id + '-call', 'Agent', { description: 'x', run_in_background: true, ...input }, n),
  result(id + '-call', 'Async agent launched successfully.', n, false, { isAsync: true, status: 'async_launched', agentId: id })];
const arrive = (id, n, report) => [handBack(id, report, n), notice(id, n, report)];
const run = (id, n, input, report) => [...launch(id, n, input), ...arrive(id, n + 1, report)];
const REVIEWER = { subagent_type: 'independent-reviewer', prompt: 'You are the independent reviewer (read-only). Review the diff.' };
const CHECKER = { subagent_type: 'braintrust-expert-sonnet', prompt: 'Seat: Note check. Try to refute each open note. Read-only.' };
const GAP = 'RECOMMEND: FAIL\n- Gap — Upload.cs:9 — the error text is not translated';
const ASK = 'RECOMMEND: PASS\n- Question — Upload.cs:9 — should the limit be 50 or 100?';
const EV = 'ar.json:12 already holds upload.errorTooBig, so the text is translated';
const REFUTED = 'REFUTED 1 — ' + EV;
const CONFIRMED = 'CONFIRMED 1 — Upload.cs:9 the text is still English';
const REF = 'NOTE 1: refuted — ' + EV;
let k = 0;
const edit = (n, file = repo + '/src/Upload.cs') => { k++; return [call('e' + k, 'Edit', { file_path: file }, n), result('e' + k, 'File updated.', n)]; };
const pass = (n) => { k++; return shell('t' + k, 'dotnet test', 'Passed!  - Failed:     0, Passed:     3', n); };
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
const gap = () => run('rv1', 1, REVIEWER, GAP);

test('C2: a code or test edit after the checker launch cancels the refutation', () => {
  const after = scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7), say(REF, 9)]);
  assert.deepEqual(outcomes(after), [null], 'edit after the check');
  assert.match(after.reviewNotes[0].problem, /run the note check again/);
  assert.deepEqual(outcomes(scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...edit(5), ...arrive('nc1', 6, REFUTED), say(REF, 9)])), [null], 'edit between the launch and the answer');
  // 2026-11-18 (scoped staleness): a test file counts when the note or the evidence names it.
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7, repo + '/tests/UploadTests.cs'), say(REF, 9)])), ['refuted'], 'a test edit of a file nobody cites keeps it');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, 'REFUTED 1 — tests/UploadTests.cs:12 already covers the translated text'), ...edit(7, repo + '/tests/UploadTests.cs'), say('NOTE 1: refuted — tests/UploadTests.cs:12 already covers the translated text', 9)])), [null], 'a test edit of the file the evidence names');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7), ...pass(8), say(REF, 9)])), [null], 'edit and a passing check');
});

test('C2: the final text of the stop is judged the same way (openNotesAfter)', () => {
  const fresh = scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED)]);
  assert.equal(scan.openNotesAfter(fresh, REF).length, 0);
  const stale = scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7)]);
  assert.equal(scan.openNotesAfter(stale, REF).length, 1);
  assert.match(scan.openNotesMessage(scan.openNotesAfter(stale, REF)), /run the note check again/);
});

test('C2: must not change: an edit before the launch, a prose edit, and a newer check after the edit keep the refutation', () => {
  assert.deepEqual(outcomes(scanOf([...gap(), ...edit(2), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 9)])), ['refuted'], 'edit before the launch');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7, repo + '/docs/readme.md'), say(REF, 9)])), ['refuted'], 'a prose edit');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7), ...run('nc2', 8, CHECKER, REFUTED), say(REF, 12)])), ['refuted'], 'a newer check after the edit');
});

test('C3: results apply in launch order: a late result of an older launch changes nothing', () => {
  // nc1 launched first, nc2 second; nc2 answers CONFIRMED first, then nc1 answers REFUTED
  const lateRefuted = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...launch('nc2', 5, CHECKER), ...arrive('nc2', 6, CONFIRMED), ...arrive('nc1', 7, REFUTED), say(REF, 9)]);
  assert.deepEqual(outcomes(lateRefuted), [null], 'the older REFUTED arrives last');
  assert.deepEqual(lateRefuted.reviewRefutable, []);
  // nc2 (newer) refutes first, then the older nc1 says CONFIRMED: the newest launch wins
  const lateConfirmed = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...launch('nc2', 5, CHECKER), ...arrive('nc2', 6, REFUTED), ...arrive('nc1', 7, CONFIRMED), say(REF, 9)]);
  assert.deepEqual(outcomes(lateConfirmed), ['refuted'], 'the older CONFIRMED arrives last');
});

test('C4: a CONFIRMED of a newer launch reopens a note closed as refuted; user and fixed closures stay', () => {
  const reopened = scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7), ...run('nc2', 9, CHECKER, CONFIRMED)]);
  assert.deepEqual(outcomes(reopened), [null]);
  assert.deepEqual(reopened.refutedNotes, []);
  assert.deepEqual(reopened.reviewRefutable, []);
  assert.deepEqual(scan.openNotesAfter(reopened, REF).map((n) => n.n), [1], 'the old refuted line cannot close it again');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7), ...run('nc2', 9, CHECKER, CONFIRMED), say(REF, 12)])), [null], 'a second refuted line is refused too');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7), ...run('nc2', 9, CHECKER, 'UNSURE 1 — the file was not readable')])), ['refuted'], 'UNSURE does not reopen');
  const user = scanOf([...gap(), userSays('leave the translation as it is for now', 5), say('NOTE 1: user — "leave the translation as it is"', 6), ...run('nc2', 9, CHECKER, CONFIRMED)]);
  assert.deepEqual(outcomes(user), ['user']);
  const fixed = scanOf([...gap(), ...edit(3), ...pass(4), say('NOTE 1: fixed — added the AR key and UploadTests.TooBig_ShowsText', 5), ...run('nc2', 9, CHECKER, CONFIRMED)]);
  assert.deepEqual(outcomes(fixed), ['fixed']);
});

test('C4: must not change: an older launch CONFIRMED arriving after the closure does not reopen it', () => {
  const r = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...launch('nc2', 5, CHECKER), ...arrive('nc2', 6, REFUTED), say(REF, 7), ...arrive('nc1', 8, CONFIRMED)]);
  assert.deepEqual(outcomes(r), ['refuted']);
});

test('C5: a Question is never refutable, whatever the checker says', () => {
  const ask = () => run('rv1', 1, REVIEWER, ASK);
  const r = scanOf([...ask(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 8)]);
  assert.equal(r.reviewNotes[0].kind, 'Question');
  assert.deepEqual(outcomes(r), [null]);
  assert.match(r.reviewNotes[0].problem, /Question is closed only by the words the user typed/);
  assert.deepEqual(r.reviewRefutable, []);
  const decide = scanOf([...run('rv1', 1, REVIEWER, 'RECOMMEND: PASS\nThe export may also include archived rows: you decide.'), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 8)]);
  assert.equal(decide.reviewNotes[0].kind, 'Question');
  assert.deepEqual(outcomes(decide), [null]);
  // the user's own words close it
  const closed = scanOf([...ask(), ...run('nc1', 4, CHECKER, REFUTED), userSays('keep the limit at fifty please', 8), say('NOTE 1: user — "keep the limit at fifty"', 9)]);
  assert.deepEqual(outcomes(closed), ['user']);
});

test('C3/C4: an incremental scan equals a from-zero scan across the generation steps', () => {
  const steps = [
    gap(),
    [...launch('nc1', 4, CHECKER), ...launch('nc2', 5, CHECKER), ...arrive('nc2', 6, REFUTED), ...arrive('nc1', 7, CONFIRMED)],
    [say(REF, 9)],
    run('nc3', 11, CHECKER, CONFIRMED),
    [...edit(14), ...run('nc4', 15, CHECKER, REFUTED), say(REF, 18)],
  ];
  const file = path.join(root, 'grow.jsonl');
  fs.writeFileSync(file, '');
  for (let i = 0; i < steps.length; i++) {
    fs.appendFileSync(file, lines(steps[i]));
    assert.deepEqual(scan.scanTranscript(file), fullScan(file), 'step ' + (i + 1));
  }
  assert.deepEqual(outcomes(scan.scanTranscript(file)), ['refuted']);
});
