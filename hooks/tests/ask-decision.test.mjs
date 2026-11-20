import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-19 (the owner's yes): an answer the owner gave in the dialog may close a LATER note about the same
// thing. Only behind his own switch (git config sanad.carryDecision true), only when the independent note
// checker wrote `SAME <n> = <k>`, note k was closed by that dialog answer, and no file either note names
// changed since. A Blocker, a security note and a ticket-line note are never closed that way. With the switch
// off every case here reads as before: the note stays open.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-decision-'))).replace(/\\/g, '/');
const stateDir = root + '/state';
process.env.SANAD_STATE_DIR = stateDir;
const SINCE = '2026-01-01T00:00:00.000Z';
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(stateDir + '/review-notes-since', SINCE + '\n');
// The switch is read with git in the session's folder: no setting of this machine may leak in.
fs.writeFileSync(root + '/empty.gitconfig', '');
process.env.GIT_CONFIG_GLOBAL = root + '/empty.gitconfig';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const scan = createRequire(import.meta.url)(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function repoWith(name, value) {
  const dir = root + '/' + name;
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  git('init', '-q');
  if (value !== null) git('config', 'sanad.carryDecision', value);
  return dir;
}
const ON = repoWith('on', 'true'), OFF = repoWith('off', null), NO = repoWith('no', 'false');

const at = (n) => new Date(Date.UTC(2026, 10, 19, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, isError = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], n, toolUseResult ? { toolUseResult } : {});
const say = (text, n) => msg('assistant', [{ type: 'text', text }], n);
const userSays = (text, n) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: at(n), origin: { kind: 'human' } });
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
const CHECKER = { subagent_type: 'braintrust-expert-sonnet', prompt: 'Seat: Note check. Say which open notes repeat a note the user decided. Read-only.' };
const ask = (id, question, n) => call(id, 'AskUserQuestion', { questions: [{ question, header: 'Note', multiSelect: false, options: [{ label: 'Fix it now', description: 'x' }, { label: 'Leave it', description: 'y' }] }] }, n);
const answered = (id, question, answer, n) => result(id, 'Your questions have been answered: "' + question + '"="' + answer + '". You can now continue with these answers in mind.',
  n, false, { questions: [{ question }], answers: { [question]: answer }, annotations: {} });
let k = 0;
const edit = (n, file) => { k++; return [call('e' + k, 'Edit', { file_path: file }, n), result('e' + k, 'File updated.', n)]; };

const FIRST = 'RECOMMEND: PASS\n- Gap — Upload.cs:9 — the error text is not translated';
const LATER = 'RECOMMEND: PASS\n- Gap — Upload.cs:14 — the error text of the second branch is not translated';
const Q = 'NOTE 1: the error text is not translated. Fix it now?';
const WORDS = 'Leave the English text for this release';
const CLOSE_1 = 'NOTE 1: user — "' + WORDS + '"';
const CLOSE_2 = 'NOTE 2: user — "' + WORDS + '"';
// The session up to the owner's answer, which closes note 1; then a later report, the checker, the author's line.
const decided = () => [...run('rv1', 1, REVIEWER, FIRST), ask('q1', Q, 4), answered('q1', Q, WORDS, 5), say(CLOSE_1, 6)];
const session = ({ later = LATER, checker = 'SAME 2 = 1', line = CLOSE_2, between = [], head = decided() } = {}) =>
  [...head, ...run('rv2', 8, REVIEWER, later), ...between, ...(checker === null ? [] : run('nc1', 11, CHECKER, checker)), ...(line ? [say(line, 14)] : [])];
let files = 0;
function write(entries, cwd) {
  const f = root + '/t' + (++files) + '.jsonl';
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(cwd ? { ...e, cwd } : e) + '\n').join(''));
  return f;
}
const scanOf = (entries, cwd = ON) => scan.scanTranscript(write(entries, cwd));
const outcomes = (r) => r.reviewNotes.map((n) => n.outcome);
const NOT_TYPED = /not in a message the user typed after this report/;

test('with the owner\'s switch on, the checker\'s SAME line lets his dialog answer close the later note', () => {
  const r = scanOf(session());
  assert.deepEqual(outcomes(r), ['user', 'user']);
  assert.equal(r.reviewNotes[1].carried, 1, 'the note says which note\'s answer closed it');
  assert.deepEqual(r.carriedNotes.map((n) => [n.n, n.from]), [[2, 1]], 'listed for the ship brief');
  assert.deepEqual(r.openReviewNotes, []);
  assert.deepEqual(outcomes(scanOf(session({ checker: '- **SAME**: NOTE 2 = NOTE 1 — the same missing translation, one branch lower' }))), ['user', 'user'], 'the line with list and bold marks');
});

test('with the switch off or unset, the same session leaves the later note open, as before', () => {
  for (const [name, cwd] of [['unset', OFF], ['false', NO], ['no folder in the session', '']]) {
    const r = scanOf(session(), cwd);
    assert.deepEqual(outcomes(r), ['user', null], name);
    assert.match(r.reviewNotes[1].problem, NOT_TYPED, name);
    assert.deepEqual(r.carriedNotes, [], name);
  }
});

test('only the independent note checker links two notes; the author never does', () => {
  assert.deepEqual(outcomes(scanOf(session({ checker: null }))), ['user', null], 'no SAME line');
  assert.deepEqual(outcomes(scanOf(session({ checker: null, line: 'SAME 2 = 1\n' + CLOSE_2 }))), ['user', null], 'the author writes the line');
  assert.deepEqual(outcomes(scanOf(session({ checker: null, between: [...run('rv3', 9.2, REVIEWER, 'RECOMMEND: PASS\nSAME 2 = 1')] }))), ['user', null], 'a reviewer writes the line');
  assert.deepEqual(outcomes(scanOf(session({ checker: null, between: [...run('ex1', 9.2, { subagent_type: 'braintrust-expert', prompt: 'Seat: Skeptic. Read the plan.' }, 'SAME 2 = 1')] }))), ['user', null], 'another expert seat writes the line');
  assert.deepEqual(outcomes(scanOf(session({ checker: 'The plan:\n```\nSAME 2 = 1\n```\nCONFIRMED 2' }))), ['user', null], 'the line inside a code block');
  assert.deepEqual(outcomes(scanOf(session({ checker: 'The SAME 2 = 1 form is not given here.\nsame 2 = 1' }))), ['user', null], 'prose and lower case');
  assert.deepEqual(outcomes(scanOf(session({ checker: 'SAME 2 = 2\nSAME 2 = 7\nSAME 9 = 1' }))), ['user', null], 'a note tied to itself or to a note that does not exist');
  // The checker ran before the later note existed: its line cannot be about it.
  const early = [...decided(), ...run('nc1', 6.5, CHECKER, 'SAME 2 = 1'), ...run('rv2', 8, REVIEWER, LATER), say(CLOSE_2, 14)];
  assert.deepEqual(outcomes(scanOf(early)), ['user', null], 'the checker launched before the later report');
  // The same, with its answer arriving after the later report: it still read the code before that note.
  const lateAnswer = [...decided(), ...launch('nc1', 6.5, CHECKER), ...run('rv2', 8, REVIEWER, LATER), handBack('nc1', 'SAME 2 = 1', 11), notice('nc1', 11, 'SAME 2 = 1'), say(CLOSE_2, 14)];
  assert.deepEqual(outcomes(scanOf(lateAnswer)), ['user', null], 'launched before the later report, answered after it');
});

test('the first note must be closed by the owner\'s own dialog answer, and the quote must be in it', () => {
  const typed = [...run('rv1', 1, REVIEWER, FIRST), userSays(WORDS, 5), say(CLOSE_1, 6)];
  assert.deepEqual(outcomes(scanOf(session({ head: typed }))), ['user', null], 'closed by typed chat words: not carried');
  // The same words in a dialog about something else, before the note existed: that answer did not close note 1.
  const other = 'Which text for the plan?';
  const elsewhere = [ask('q0', other, 0.2), answered('q0', other, WORDS, 0.4), ...typed];
  assert.deepEqual(outcomes(scanOf(session({ head: elsewhere }))), ['user', null], 'an earlier dialog answer with the same words is not the note\'s answer');
  const open = [...run('rv1', 1, REVIEWER, FIRST), ask('q1', Q, 4), answered('q1', Q, WORDS, 5)];
  assert.deepEqual(outcomes(scanOf(session({ head: open }))), [null, null], 'the first note is still open');
  assert.deepEqual(outcomes(scanOf(session({ line: 'NOTE 2: user — "Fix it now, please do"' }))), ['user', null], 'words the owner did not say');
  assert.deepEqual(outcomes(scanOf(session({ line: 'NOTE 2: user — "the error text is not translated. Fix it now?"' }))), ['user', null], 'the question\'s own text');
  const rejected = [...run('rv1', 1, REVIEWER, FIRST), ask('q1', Q, 4), result('q1', 'The user doesn\'t want to proceed with this tool use.', 5, true)];
  assert.deepEqual(outcomes(scanOf(session({ head: [...rejected, say(CLOSE_1, 6)] }))), [null, null], 'a dialog the owner closed gives no answer');
});

test('a Blocker, a security note and a ticket-line note are never closed by an earlier answer', () => {
  const blocker = 'RECOMMEND: FAIL\n- Blocker — Upload.cs:14 — the error text of the second branch is not translated';
  assert.deepEqual(outcomes(scanOf(session({ later: blocker }))), ['user', null], 'a Blocker');
  const security = 'RECOMMEND: PASS\n- Gap — Upload.cs:14 — the second branch skips the permission check, the same shape as note 1';
  assert.deepEqual(outcomes(scanOf(session({ later: security }))), ['user', null], 'a security note');
  const ticket = 'RECOMMEND: PASS\n- Gap — Upload.cs:14 — ticket line 3 says the text is Arabic; it is not translated';
  assert.deepEqual(outcomes(scanOf(session({ later: ticket }))), ['user', null], 'a ticket-line note');
  for (const tag of ['[T3]', '[C2]', '[C1, C2]', '[C1][C2]', '[T1,T2]', 'C2', 'T3']) {
    const tagged = 'RECOMMEND: PASS\n- Gap — Upload.cs:14 — ' + tag + ' is not met in the second branch';
    assert.deepEqual(outcomes(scanOf(session({ later: tagged }))), ['user', null], 'a note holding ' + tag);
  }
});

test('the limit holds for the EARLIER note too, and data loss or saved data is a limited matter', () => {
  const headFor = (first) => [...run('rv1', 1, REVIEWER, first), ask('q1', Q, 4), answered('q1', Q, WORDS, 5), say(CLOSE_1, 6)];
  const firsts = [
    'RECOMMEND: FAIL\n- Blocker — Upload.cs:9 — the error text is not translated',
    'RECOMMEND: PASS\n- Gap — Upload.cs:9 — the error text is not translated and the permission check is skipped',
    'RECOMMEND: PASS\n- Gap — Upload.cs:9 — ticket line 3 says the error text is Arabic; it is not translated',
    'RECOMMEND: PASS\n- Gap — Upload.cs:9 — [T3] the error text is not translated',
    'RECOMMEND: PASS\n- Gap — Upload.cs:9 — [C1, C2] the error text is not translated',
    'RECOMMEND: PASS\n- Gap — Upload.cs:9 — C2 has no test; the error text is not translated',
    'RECOMMEND: PASS\n- Gap — Upload.cs:9 — the error text is not translated and a retry can cause data loss',
  ];
  for (const first of firsts) assert.deepEqual(outcomes(scanOf(session({ head: headFor(first) }))), ['user', null], first);
  for (const word of ['data loss', 'saved data']) {
    const later = 'RECOMMEND: PASS\n- Gap — Upload.cs:14 — the second branch risks ' + word + '; the error text is not translated';
    assert.deepEqual(outcomes(scanOf(session({ later }))), ['user', null], word);
  }
  assert.deepEqual(outcomes(scanOf(session())), ['user', 'user'], 'a plain pair still carries');
});

test('a change of a file either note names since the answer cancels it; another file does not', () => {
  assert.deepEqual(outcomes(scanOf(session({ between: edit(9.5, ON + '/src/Upload.cs') }))), ['user', null], 'the cited file changed after the answer');
  assert.deepEqual(outcomes(scanOf(session({ between: edit(9.5, ON + '/src/Other.cs') }))), ['user', 'user'], 'a file nobody cites');
  const shellEdit = [call('s1', 'Bash', { command: 'git checkout origin/staging -- .' }, 9.5), result('s1', 'Updated 3 paths', 9.5)];
  assert.deepEqual(outcomes(scanOf(session({ between: shellEdit }))), ['user', null], 'a git move of unknown files');
});

test('the stop gate\'s final text gets the same answer as a line in the session', () => {
  const r = scanOf(session({ line: null }));
  assert.deepEqual(outcomes(r), ['user', null]);
  assert.deepEqual(scan.openNotesAfter(r, CLOSE_2), [], 'switch on');
  assert.deepEqual(outcomes(r), ['user', null], 'the scan result itself is not changed');
  const off = scanOf(session({ line: null }), OFF);
  assert.deepEqual(scan.openNotesAfter(off, CLOSE_2).map((n) => n.n), [2], 'switch off');
  const noLink = scanOf(session({ line: null, checker: null }));
  assert.deepEqual(scan.openNotesAfter(noLink, 'SAME 2 = 1\n' + CLOSE_2).map((n) => n.n), [2], 'no checker line');
});

test('a second scan that reads only the new lines gives the same answer as a scan from zero', () => {
  const all = session();
  const file = write(all.slice(0, 6), ON);
  scan.scanTranscript(file);
  fs.appendFileSync(file, all.slice(6).map((e) => JSON.stringify({ ...e, cwd: ON }) + '\n').join(''));
  const grown = scan.scanTranscript(file);
  const saved = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = fs.mkdtempSync(root + '/fresh-');
  fs.writeFileSync(path.join(process.env.SANAD_STATE_DIR, 'review-notes-since'), SINCE + '\n');
  let fresh;
  try { fresh = scan.scanTranscript(file); } finally { process.env.SANAD_STATE_DIR = saved; }
  assert.deepEqual(outcomes(grown), ['user', 'user']);
  assert.deepEqual(grown, fresh);
});
