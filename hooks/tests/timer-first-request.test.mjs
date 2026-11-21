// hooks/lib/timer-idle.cjs autoStart: the task timer starts at the task's FIRST request.
// 2026-11-17 (audit S7, "Existing timing cannot support speed comparisons"): the start was the LAST message
// before the first code edit, at most 60 minutes back. A request at 10:00 and a "go" at 10:20 started the
// task at 10:20, and a plan longer than an hour started it at the first edit: the time before the approval
// was never counted, so two tasks could not be compared.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { autoStart, autoEnd } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'timer-idle.cjs'));

// This machine's git settings never reach the fixtures (an empty global file, no system file), and no test
// writes into the real state folder: each fixture names its own.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-first-'));
fs.writeFileSync(path.join(scratch, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(scratch, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.SANAD_STATE_DIR = path.join(scratch, 'state');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const SID = 'first-request';
const at = (hhmm) => new Date(`2026-11-17T${hhmm}:00.000Z`);
const iso = (hhmm) => at(hhmm).toISOString();
// The temp folder never counts as code in a real session, so the tests name what does.
const isCode = (f) => f.endsWith('.cs');

const said = (hhmm, content, more = {}) => ({ type: 'user', timestamp: iso(hhmm), message: { role: 'user', content }, ...more });
const answered = (hhmm, text) => ({ type: 'assistant', timestamp: iso(hhmm), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolResult = (hhmm, content = 'ok') => said(hhmm, [{ type: 'tool_result', tool_use_id: 't1', content }]);
// The session kept working between two times: a tool result every 20 minutes, so no long silence.
const working = (from, to) => {
  const results = [];
  for (let t = at(from).getTime() + 20 * 60000; t < at(to).getTime(); t += 20 * 60000) results.push({ ...toolResult('00:00'), timestamp: new Date(t).toISOString() });
  return results;
};
// A guessed start is labelled an estimate; a start the session wrote down at routing (the request file) is not.
const START = "start (auto, estimate): the user's message — repo";
const START_ASKED = "start (auto): the user's message — repo";
const WAITING = 'waiting for the user';
const AT_EDIT = 'start (auto): first code edit — repo';

// A session of its own: a state folder, a git repository named "repo" and a transcript where a real one sits.
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 't-'));
  const state = path.join(root, 'state'), repo = path.join(root, 'repo');
  const transcript = path.join(root, '.claude', 'projects', 'p', SID + '.jsonl');
  for (const d of [state, repo, path.dirname(transcript)]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  process.env.SANAD_STATE_DIR = state;
  const edit = { session_id: SID, transcript_path: transcript, cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.cs') } };
  return {
    state, transcript, edit,
    write: (entries, eol = '\n') => fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join(eol) + eol),
    start: (hhmm) => autoStart(edit, at(hhmm), { isCode }),
  };
}
// The marks of a timer: [time, words]. marks() leaves out the waits for the user's go; allMarks() shows them.
const allMarks = (dir) => fs.readFileSync(path.join(dir, 'timer.tsv'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
  const [time, , ...words] = line.split('\t');
  return [time, words.join(' ')];
});
const marks = (dir) => allMarks(dir).filter(([, w]) => w !== WAITING && !w.startsWith('resumed'));
// A gate that passed after the last edit, as the stop hook's scan reports it.
const gatePassed = (hhmm) => ({ lastEdit: 5, lastGate: 9, lastGateVerdict: 'PASS', lastGateAt: iso(hhmm) });

test('a request at 10:00 and a "go" at 10:20: the task starts at 10:00, not at the approval', () => {
  const f = fixture();
  f.write([said('10:00', 'the export is slow: fix it'), answered('10:05', 'Plan: one query instead of forty.'), said('10:20', 'go'), toolResult('10:20')]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('10:00'), START], [iso('10:21'), 'first code edit']]);
});

test('a plan longer than an hour still starts at the request (the transcript has CRLF lines)', () => {
  const f = fixture();
  f.write([said('08:01', 'plan the new report page'), ...working('08:01', '09:10'), said('09:10', 'option two, go'), ...working('09:10', '10:21')], '\r\n');
  assert.deepEqual(marks(f.start('10:21')), [[iso('08:01'), START], [iso('10:21'), 'first code edit']]);
});

test('a message more than four hours before the first edit is not this task', () => {
  const f = fixture();
  f.write([said('05:00', 'what does this page do?'), said('07:30', 'add a filter to it'), ...working('07:30', '10:19'), said('10:19', 'go')]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('07:30'), START], [iso('10:21'), 'first code edit']], 'the first message inside the four hours');

  const old = fixture();
  old.write([said('05:00', 'what does this page do?'), toolResult('10:20')]);
  assert.deepEqual(marks(old.start('10:21')), [[iso('10:21'), AT_EDIT]], 'nothing typed in the four hours: the first edit');

  const none = fixture();
  assert.deepEqual(marks(none.start('10:21')), [[iso('10:21'), AT_EDIT]], 'no transcript to read: the first edit');
});

test('the next task starts at the first message after the timer before it ended', () => {
  const f = fixture();
  // Task one worked until its gate: no long silence sets it apart from the next request, only its end does.
  const one = [said('09:00', 'task one: fix the login'), toolResult('09:04'), ...working('09:04', '09:40')];
  f.write(one);
  const first = f.start('09:05');
  assert.equal(autoEnd(f.edit, gatePassed('09:40'), at('09:41')), true);

  const two = [...one, said('09:50', 'next: the report page'), answered('09:55', 'Plan: …'), said('10:15', 'go')];
  f.write(two);
  const second = f.start('10:21');
  assert.notEqual(second, first);
  assert.deepEqual(marks(second), [[iso('09:50'), START], [iso('10:21'), 'first code edit']]);

  // A third task: the second timer is the timer before now (its name replaces the first one's).
  assert.equal(autoEnd(f.edit, gatePassed('10:40'), at('10:41')), true);
  assert.equal(fs.existsSync(path.join(f.state, 'sanad-timer-active-' + SID)), false, 'ended: no active timer');
  f.write([...two, said('10:50', 'third: the footer'), said('10:54', 'yes')]);
  assert.deepEqual(marks(f.start('10:55')), [[iso('10:50'), START], [iso('10:55'), 'first code edit']]);
});

test('a message of the task before never starts the next task', () => {
  const f = fixture();
  // The work goes on by itself after the end (a helper's notice, no new message of the user).
  f.write([said('09:00', 'task one: fix the login'), toolResult('09:04'), said('09:52', '<task-notification>\n<status>completed</status>\n</task-notification>')]);
  f.start('09:05');
  assert.equal(autoEnd(f.edit, gatePassed('09:50'), at('09:51')), true);
  assert.deepEqual(marks(f.start('09:55')), [[iso('09:55'), AT_EDIT]], 'task one was asked at 09:00: that is not the start of this one');
});

// The price of a start that looks back: the talk after a task (the yes to its push) is not the next task.
// The user's own return after a long silence marks where the next one begins.
test('a second round hours after the push counts from its own request, not from the yes to the push', () => {
  const f = fixture();
  const one = [said('07:00', 'task one: fix the login'), toolResult('07:04')];
  f.write(one);
  f.start('07:05');
  assert.equal(autoEnd(f.edit, gatePassed('07:40'), at('07:41')), true);
  f.write([...one, said('07:43', 'yes, push'), toolResult('07:45'), said('09:40', 'the reviewer left six comments: fix them'), toolResult('09:44'), said('09:58', 'go')]);
  assert.deepEqual(marks(f.start('10:00')), [[iso('09:40'), START], [iso('10:00'), 'first code edit']], 'not 07:43 (the yes to the push) and not 09:58 (the go)');

  // The same rule when the long silence is before the go: the task counts from the go. The minutes of the
  // plan before the silence are not counted, and neither is the silence (the old rule gave the same start).
  const slow = fixture();
  slow.write([said('09:00', 'plan the report page'), toolResult('09:08'), said('09:58', 'go')]);
  assert.deepEqual(marks(slow.start('10:00')), [[iso('09:58'), START], [iso('10:00'), 'first code edit']]);
});

test('the timer before is known by its folder: a folder that is gone gives the first message of the four hours', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'sanad-timer-last-' + SID), path.join(f.state, 'timers', 'deleted'));
  f.write([said('09:50', 'the report page'), said('10:15', 'go')]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('09:50'), START], [iso('10:21'), 'first code edit']]);
});

test('pasted text is the request; a compaction summary, an interruption and a notice are not the user', () => {
  const notices = [
    { ...said('09:55', 'This session is being continued from a previous conversation that ran out of context.'), isCompactSummary: true, isVisibleInTranscriptOnly: true },
    said('10:00', '<task-notification>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system' }),
    said('10:10', [{ type: 'text', text: '[Request interrupted by user]' }]),
    said('10:12', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    toolResult('10:15'),
    { ...said('10:16', 'Stop hook feedback: run the check first'), isMeta: true },
    // An entry that holds a tool result is the tool's answer, whatever words come with it.
    said('10:17', [{ type: 'tool_result', tool_use_id: 't2', content: 'cancelled' }, { type: 'text', text: 'The tool run was cancelled.' }]),
  ];
  const f = fixture();
  // What Claude Code writes for a pasted request: it starts with a tag, and its sender is the human.
  f.write([said('09:50', '<pasted_content id="p1a">\n/sanad fix the slow export\n</pasted_content id="p1a">', { origin: { kind: 'human' }, promptSource: 'typed' }), ...notices]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('09:50'), START], [iso('10:21'), 'first code edit']]);

  const only = fixture();
  only.write(notices);
  assert.deepEqual(marks(only.start('10:21')), [[iso('10:21'), AT_EDIT]], 'no request of the user: the first edit');
});

test('a request far above the last megabytes of the transcript is found', () => {
  const f = fixture();
  // Five file reads after the request, 1.4 MB each; "é" is two bytes, so a read can end inside a letter.
  const big = 'é'.repeat(700000);
  f.write([said('10:00', 'find why the import is slow, then fix it'), ...['10:01', '10:02', '10:03', '10:04', '10:05'].map((t) => toolResult(t, big))]);
  assert.ok(fs.statSync(f.transcript).size > 6 * 1024 * 1024);
  assert.deepEqual(marks(f.start('10:21')), [[iso('10:00'), START], [iso('10:21'), 'first code edit']]);
});

test('an entry written late with an older time does not hide the request after it', () => {
  const f = fixture();
  const one = [said('09:00', 'task one: fix the login'), toolResult('09:04')];
  f.write(one);
  f.start('09:05');
  assert.equal(autoEnd(f.edit, gatePassed('09:40'), at('09:41')), true);
  // Real transcripts hold user entries up to an hour older than the entry before them. 09:20 is before the
  // end of task one, and the request of 09:50 sits above it.
  f.write([...one, said('09:50', 'next: the report page'), toolResult('09:20'), said('10:15', 'go')]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('09:50'), START], [iso('10:21'), 'first code edit']]);

  // The reading is bounded: it ends at an entry more than an hour older than the four hours (05:00 here),
  // so a long session is not read to its top at every task. What sits above that entry is not looked at.
  const long = fixture();
  long.write([said('07:00', 'written above an entry of 05:00'), toolResult('05:00'), ...working('07:00', '10:00'), said('10:00', 'fix the export')]);
  assert.deepEqual(marks(long.start('10:21')), [[iso('10:00'), START], [iso('10:21'), 'first code edit']]);
});

// The one place that starts a timer in a real session: check-lock-guard.js, at the tool call of the edit.
test('through the tool-call hook: the first code edit starts the timer at the first request', (t) => {
  const f = fixture();
  // A git folder under AppData/Local/Temp counts as code; another system's temp folder may not.
  const { isCodePath } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'transcript-scan.js'));
  if (!isCodePath(f.edit.tool_input.file_path)) return t.skip('a file in this temp folder does not count as code on this system');
  // The hook reads the clock itself, so the entries are placed before now: a request 90 minutes ago, work
  // every 20 minutes since, and the go 2 minutes ago.
  const now = Date.now(), ago = (min) => new Date(now - min * 60000).toISOString();
  const entry = (min, content) => ({ type: 'user', timestamp: ago(min), message: { role: 'user', content } });
  f.write([entry(90, 'the export is slow: fix it'), ...[70, 50, 30, 10].map((min) => entry(min, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])), entry(2, 'go')]);
  execFileSync(process.execPath, [path.join(hooks, 'check-lock-guard.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', ...f.edit }), encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, SANAD_STATE_DIR: f.state } });
  const timers = fs.readdirSync(path.join(f.state, 'timers'));
  assert.equal(timers.length, 1, 'one timer started');
  assert.deepEqual(marks(path.join(f.state, 'timers', timers[0]))[0], [ago(90), START], 'the request of 90 minutes ago, not the go of 2 minutes ago');
});

test('a request with a pasted picture: the notice written at the same time does not hide the 30-minute silence', () => {
  const f = fixture();
  const picture = said('10:00', [{ type: 'text', text: 'the export is slow: fix it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
  const notice = said('10:00', [{ type: 'text', text: '[Image: source: C:/x.png]' }], { isMeta: true });
  f.write([said('09:00', 'what does the export page do?'), toolResult('09:02'), picture, notice, toolResult('10:03'), said('10:20', 'go')]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('10:00'), START], [iso('10:21'), 'first code edit']]);
});

test('a request above 64 MB of tool output is still found', () => {
  const f = fixture();
  const line = JSON.stringify(toolResult('10:01', 'x'.repeat(350000)));
  const fd = fs.openSync(f.transcript, 'w');
  fs.writeSync(fd, JSON.stringify(said('10:00', 'find why the import is slow, then fix it')) + '\n');
  for (let i = 0; i < 200; i++) fs.writeSync(fd, line + '\n');
  fs.closeSync(fd);
  assert.ok(fs.statSync(f.transcript).size > 64 * 1024 * 1024);
  assert.deepEqual(marks(f.start('10:21')), [[iso('10:00'), START], [iso('10:21'), 'first code edit']]);
});

test('a start written down when Sanad routed the task beats the guess, and is no estimate', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'sanad-task-start-' + SID), iso('10:00'));
  // (a) a question 20 minutes before is other talk; the 10:00 routing is the start.
  f.write([said('09:40', 'what does the export page do?'), toolResult('09:42'), said('10:00', 'make the login faster'), toolResult('10:03'), said('10:20', 'go')]);
  assert.deepEqual(marks(f.start('10:21')), [[iso('10:00'), START_ASKED], [iso('10:21'), 'first code edit']]);
  assert.equal(fs.existsSync(path.join(f.state, 'sanad-task-start-' + SID)), false, 'used once');

  // (c) the yes to the push of the task before is not the start: the routing of the next task is.
  const g = fixture();
  const one = [said('09:00', 'task one'), toolResult('09:04')];
  g.write(one);
  g.start('09:05');
  assert.equal(autoEnd(g.edit, gatePassed('09:41'), at('09:41')), true);
  fs.writeFileSync(path.join(g.state, 'sanad-task-start-' + SID), iso('09:50'));
  g.write([...one, said('09:43', 'yes, push'), toolResult('09:45'), said('09:50', 'next: the footer'), said('09:54', 'go')]);
  assert.deepEqual(marks(g.start('09:55')), [[iso('09:50'), START_ASKED], [iso('09:55'), 'first code edit']]);

  // A request file older than the end of the last timer is a leftover: the guess is used and labelled.
  const h = fixture();
  h.write(one);
  h.start('09:05');
  assert.equal(autoEnd(h.edit, gatePassed('09:41'), at('09:41')), true);
  fs.writeFileSync(path.join(h.state, 'sanad-task-start-' + SID), iso('09:00'));
  h.write([...one, said('09:50', 'next: the footer')]);
  assert.deepEqual(marks(h.start('09:55')), [[iso('09:50'), START], [iso('09:55'), 'first code edit']]);
});

test("the wait for the user's go is marked as waiting, not as work", () => {
  const f = fixture();
  f.write([said('10:00', 'the export is slow: fix it'), toolResult('10:03'), answered('10:05', 'Plan: one query.'), said('10:25', 'go')]);
  assert.deepEqual(allMarks(f.start('10:26')), [
    [iso('10:00'), START], [iso('10:03'), WAITING], [iso('10:25'), 'resumed: ' + START], [iso('10:26'), 'first code edit'],
  ]);
  // A message typed seconds after the last entry is no wait.
  const g = fixture();
  g.write([said('10:00', 'fix the export'), toolResult('10:20'), said('10:20', 'and the title too')]);
  assert.deepEqual(allMarks(g.start('10:21')).map(([, w]) => w), [START, 'first code edit']);
});

// 2026-11-19 (P7): a task that never reached its gate no longer swallows the next task's marks.
const timerScript = path.resolve(hooks, '..', 'skills', 'gate', 'scripts', 'sanad-timer.mjs');
test('a new request ends the unfinished timer, and the next task has a timer of its own from the request', () => {
  const f = fixture();
  f.write([said('10:00', 'fix the export')]);
  const first = f.start('10:05');
  assert.ok(first);
  const env = { ...process.env, SANAD_STATE_DIR: f.state, CLAUDE_CODE_SESSION_ID: SID };
  execFileSync(process.execPath, [timerScript, 'request', '--repo', path.dirname(f.edit.tool_input.file_path)], { env, encoding: 'utf8' });
  assert.equal(allMarks(first).pop()[1], 'end (auto: a new task was routed)');
  const second = fs.readFileSync(path.join(f.state, 'sanad-timer-active-' + SID), 'utf8').trim();
  assert.ok(second && path.resolve(second) !== path.resolve(first), 'request made a new active timer');
  assert.equal(allMarks(second)[0][1], "start: the user's request — repo");
  // A code edit after the request stamps the new timer; it starts no third one (an active timer is kept).
  f.write([said('10:00', 'fix the export'), said('11:00', 'now the report page')]);
  assert.equal(f.start('11:05'), null, 'no second new timer');
  const { autoStage } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'timer-idle.cjs'));
  assert.equal(autoStage(f.edit, new Date(), { isCode }), 'code');
  assert.equal(allMarks(second).pop()[1], 'code', 'the stamp landed in the request timer');
  assert.equal(allMarks(first).pop()[1], 'end (auto: a new task was routed)', 'the first timer got no new marks');
  assert.equal(fs.readdirSync(path.join(f.state, 'timers')).length, 2, 'two timers in all');
});

// 2026-11-20: a task that lives in another git work tree than the session's folder (cwd) still gets a timer.
test('an edit in a git work tree outside the session folder starts a timer named after that tree', () => {
  const f = fixture();
  const other = path.join(path.dirname(path.dirname(f.state)), 'other-tree');
  fs.mkdirSync(other, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: other, windowsHide: true });
  const edit = { ...f.edit, tool_input: { file_path: path.join(other, 'sub', 'b.cs') } };
  f.write([said('10:00', 'fix the export')]);
  const dir = autoStart(edit, at('10:05'), { isCode });
  assert.ok(dir && /-other-tree$/.test(dir), String(dir));
  // A folder that is no repository still starts nothing.
  const bare = fs.mkdtempSync(path.join(scratch, 'bare-'));
  const g = fixture();
  assert.equal(autoStart({ ...g.edit, tool_input: { file_path: path.join(bare, 'c.cs') } }, at('10:05'), { isCode }), null);
});

test('a proof start adds a run line with the tree id', () => {
  const { autoStage } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'timer-idle.cjs'));
  const f = fixture();
  f.write([said('10:00', 'fix the export')]);
  const dir = f.start('10:05');
  const input = { session_id: SID, transcript_path: f.transcript, cwd: path.dirname(f.edit.tool_input.file_path), tool_name: 'Bash', tool_input: { command: 'node /x/gate/scripts/red-proof.mjs --test a' } };
  assert.equal(autoStage(input, at('10:10'), { isCode }), 'proof');
  assert.equal(autoStage(input, at('10:11'), { isCode }), '');
  const runs = fs.readFileSync(path.join(dir, 'timer.tsv'), 'utf8').split(/\r?\n/).filter((l) => /\tside\trun proof /.test(l));
  assert.equal(runs.length, 2, 'each start is a run, though the step is added once');
});
