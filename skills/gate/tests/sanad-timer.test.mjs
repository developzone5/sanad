import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mark, readMarks, report, week, requestStart } from '../scripts/sanad-timer.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sanad-timer.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-timer-'));
const at = (hhmm) => new Date(`2026-11-09T${hhmm}:00Z`);
// One session for the whole file (each test file runs in its own process): the timer script and the hooks
// both name the active timer after it.
const SID = 'test-session';
process.env.CLAUDE_CODE_SESSION_ID = SID;
const POINTER = 'sanad-timer-active-' + SID;
// 2026-11-17: the tests that use git never read this machine's git settings (an empty global file, no system
// file), and a test that names no state folder of its own still never writes into the real one.
const scratch = tmp();
fs.writeFileSync(path.join(scratch, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(scratch, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.SANAD_STATE_DIR = path.join(scratch, 'state');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('each step lasts until the next mark, waits are counted apart, and the total adds up', () => {
  const dir = tmp();
  mark(dir, 'step', 'read the ticket', at('05:00'));
  mark(dir, 'step', 'write the code', at('05:04'));
  mark(dir, 'wait', 'MySQL was stopped', at('05:20'));
  mark(dir, 'step', 'proof', at('05:28'));
  const text = report(dir, at('05:33'));
  assert.match(text, /4\.0 min {2}read the ticket/);
  assert.match(text, /16 min {2}write the code/);
  assert.match(text, /8\.0 min {2}WAIT MySQL was stopped/);
  assert.match(text, /5\.0 min {2}proof/);
  assert.match(text, /33 min {2}total \(work 25, waiting 8\.0\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a step name cannot break the file: tabs and new lines become spaces', () => {
  const dir = tmp();
  mark(dir, 'step', 'two\twords\nand more', at('06:00'));
  assert.deepEqual(readMarks(dir).map((m) => m.text), ['two words and more']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the command line marks and reports; no marks yet says so', () => {
  const dir = tmp();
  // Its own state folder: `mark` names the active timer, and a test must not replace a real task's.
  const env = { ...process.env, SANAD_STATE_DIR: path.join(dir, 'state') };
  assert.match(execFileSync(process.execPath, [script, 'report', dir], { encoding: 'utf8', env }), /no marks yet/);
  execFileSync(process.execPath, [script, 'mark', dir, 'build', 'and', 'prove'], { encoding: 'utf8', env });
  assert.match(execFileSync(process.execPath, [script, 'report', dir], { encoding: 'utf8', env }), /build and prove/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-09: a 45-minute gap (helpers done, the session asleep) counted as work. The hooks now mark it.
test('the hooks mark idle time on the active timer: a stop starts a wait, the next tool call ends it', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { idle, resume, IDLE } = require('../../../hooks/lib/timer-idle.cjs');
  const state = tmp();
  const notes = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    const real = { session_id: SID, transcript_path: path.join(state, '.claude', 'projects', 'x', 'session.jsonl') };
    const testRun = { transcript_path: path.join(state, 'fake-transcript.jsonl') };
    execFileSync(process.execPath, [script, 'mark', notes, 'build'], { encoding: 'utf8', env: { ...process.env } });
    const now = new Date();
    assert.equal(idle(testRun, now), false, 'a hook test run never marks');
    // 2026-11-11: a proof running on the test machine counted as waiting (TUW-242: 11 work minutes of 18).
    assert.equal(idle(real, now, { busy: true }), false, 'a stop while a check of this work runs is work, not waiting');
    assert.equal(idle(real, now), true);
    assert.equal(idle(real, now), false, 'one wait at a time');
    assert.equal(resume(real, new Date(now.getTime() + 60000)), true);
    assert.deepEqual(readMarks(notes).map(m => [m.kind, m.text]), [['step', 'build'], ['wait', IDLE], ['step', 'resumed: build']]);

    mark(notes, 'wait', 'the user is checking', now);
    assert.equal(resume(real, now), false, 'a wait marked by hand stays open');

    execFileSync(process.execPath, [script, 'end', notes], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(idle(real, new Date()), false, 'after end, no more marks');
    assert.equal(fs.existsSync(path.join(state, POINTER)), false);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
  }
});

// 2026-11-10: a workflow fix the user asked for in the middle of a task counted as the task's work.
test('pause and resume: side work is a wait, the hooks leave it alone, and the last step goes on', async () => {
  const { createRequire } = await import('node:module');
  const { idle } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const { pause, resume } = await import('../scripts/sanad-timer.mjs');
  const state = tmp(), notes = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    const env = { ...process.env };
    execFileSync(process.execPath, [script, 'mark', notes, 'build'], { encoding: 'utf8', env });
    assert.match(execFileSync(process.execPath, [script, 'pause', notes, 'Sanad fixes'], { encoding: 'utf8', env }), /TIMER paused: Sanad fixes/);
    assert.equal(fs.existsSync(path.join(state, POINTER)), false, 'paused: no timer is active');
    assert.equal(idle({ session_id: SID, transcript_path: '/home/u/.claude/projects/p/s.jsonl' }), false, 'a stop during side work marks nothing');
    assert.match(execFileSync(process.execPath, [script, 'resume', notes], { encoding: 'utf8', env }), /TIMER resumed: build/);
    assert.deepEqual(readMarks(notes).map(m => [m.kind, m.text]), [['step', 'build'], ['wait', 'paused: Sanad fixes'], ['step', 'resumed: build']]);
    assert.equal(path.resolve(fs.readFileSync(path.join(state, POINTER), 'utf8')), path.resolve(notes));
    pause(notes, '', at('07:00'));
    assert.equal(resume(notes, at('07:05')), 'build', 'a second pause goes back to the same step');
    assert.match(report(notes, at('07:10')), /WAIT paused: other work/);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
  }
});

test('only one task timer runs: marking another task pauses the one that ran, and marking it again goes on', () => {
  const state = tmp(), taskA = tmp(), taskB = tmp();
  const env = { ...process.env, SANAD_STATE_DIR: state };
  try {
    execFileSync(process.execPath, [script, 'mark', taskA, 'proof'], { encoding: 'utf8', env });
    execFileSync(process.execPath, [script, 'mark', taskB, 'small fix'], { encoding: 'utf8', env });
    assert.deepEqual(readMarks(taskA).map(m => [m.kind, m.text]), [['step', 'proof'], ['wait', `paused: other task (${path.basename(taskB)})`]]);
    execFileSync(process.execPath, [script, 'mark', taskA, 'reviews'], { encoding: 'utf8', env });
    assert.deepEqual(readMarks(taskB).map(m => m.kind), ['step', 'wait'], 'the other task waits now');
    execFileSync(process.execPath, [script, 'mark', taskA, 'suites'], { encoding: 'utf8', env });
    assert.equal(readMarks(taskB).length, 2, 'the same task again pauses nothing');
  } finally {
    for (const d of [state, taskA, taskB]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// 2026-11-10: a session on another project held the one shared pointer; its marks paused this task, and
// this session's stops were marked on its timer.
test('two sessions keep their own timers: a mark in one pauses nothing in the other, and each stop marks its own', async () => {
  const { createRequire } = await import('node:module');
  const { idle, pointerName } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const { pointerName: scriptName } = await import('../scripts/sanad-timer.mjs');
  const state = tmp(), taskA = tmp(), taskB = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    execFileSync(process.execPath, [script, 'mark', taskA, 'proof'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-a' } });
    execFileSync(process.execPath, [script, 'mark', taskB, 'small fix'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-b' } });
    assert.deepEqual(readMarks(taskA).map(m => m.kind), ['step'], 'the other session paused nothing here');
    const now = new Date();
    assert.equal(idle({ session_id: 'sess-b', transcript_path: '/home/u/.claude/projects/p/sess-b.jsonl' }, now), true);
    assert.deepEqual(readMarks(taskA).map(m => m.kind), ['step'], "B's stop marks only B's timer");
    assert.deepEqual(readMarks(taskB).map(m => m.kind), ['step', 'wait']);
    // Without session_id, the transcript's file name is the session.
    assert.equal(idle({ transcript_path: 'C:\\Users\\u\\.claude\\projects\\p\\sess-a.jsonl' }, now), true);
    assert.deepEqual(readMarks(taskA).map(m => m.kind), ['step', 'wait']);
    // The script and the hooks name the file the same way; no id, the shared name.
    assert.equal(scriptName('sess-a'), pointerName({ session_id: 'sess-a' }));
    assert.equal(scriptName(''), 'sanad-timer-active');
    assert.equal(scriptName('../x'), 'sanad-timer-active-x', 'an id cannot point outside the state folder');
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    for (const d of [state, taskA, taskB]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a timer last marked long ago is left alone', async () => {
  const { createRequire } = await import('node:module');
  const { idle } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const state = tmp(), notes = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    mark(notes, 'step', 'old task', new Date('2026-01-01T00:00:00Z'));
    fs.writeFileSync(path.join(state, POINTER), notes);
    assert.equal(idle({ session_id: SID, transcript_path: '/home/u/.claude/projects/p/s.jsonl' }, new Date('2026-01-02T00:00:00Z')), false);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
  }
});

// 2026-11-11 (TUW-242): a small task's timer was started by hand 10 minutes late, and small and medium timers
// were never ended. The hooks now start one at the first code edit and end it at a passing gate.
test('the timer starts by itself at the first code edit, from the user message, and ends at GATE: PASS', async () => {
  const { createRequire } = await import('node:module');
  const { autoStart, autoEnd, userEntries } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const state = tmp(), repo = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.cs'), 'class A {}\n');
    const now = new Date();
    const asked = new Date(now.getTime() - 5 * 60000);
    const transcript = path.join(state, '.claude', 'projects', 'p', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      { type: 'user', timestamp: asked.toISOString(), message: { role: 'user', content: 'ok fix it now' } },
      { type: 'user', isMeta: true, timestamp: now.toISOString(), message: { role: 'user', content: 'Stop hook feedback: …' } },
      { type: 'user', timestamp: now.toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    // 2026-11-17 (audit S7): this line asked lastPromptAt for the LAST message, the rule that lost the time
    // before the user's "go". The start is the task's first request now, so the entries are asked for by time.
    const typed = userEntries(transcript, new Date(now.getTime() - 3600000), now).filter((e) => e.typed);
    assert.deepEqual(typed.map((e) => e.at.toISOString()), [asked.toISOString()], 'hook notes and tool results are not the user');
    // The temp folder never counts as code in a real session, so the test names what does.
    const isCode = (f) => f.endsWith('.cs');
    const edit = (file, tool = 'Edit') => ({ session_id: SID, transcript_path: transcript, cwd: repo, tool_name: tool, tool_input: { file_path: path.join(repo, file) } });

    assert.equal(autoStart(edit('README.md'), now, { isCode }), null, 'not a code file: no timer');
    assert.equal(autoStart({ ...edit('a.cs'), transcript_path: path.join(state, 'fake.jsonl') }, now), null, 'a hook test run never starts one');
    const dir = autoStart(edit('a.cs'), now, { isCode });
    assert.ok(dir && dir.startsWith(path.join(state, 'timers')), String(dir));
    assert.deepEqual(readMarks(dir).map(m => [m.at.toISOString(), m.text]), [
      [asked.toISOString(), `start (auto, estimate): the user's message — ${path.basename(repo)}`],
      [now.toISOString(), 'first code edit'],
    ]);
    assert.equal(fs.readFileSync(path.join(state, POINTER), 'utf8'), dir);
    assert.equal(autoStart(edit('a.cs'), now, { isCode }), null, 'one timer at a time');

    const later = new Date(now.getTime() + 10 * 60000);
    const old = { lastEdit: 5, lastGate: 9, lastGateVerdict: 'PASS', lastGateAt: new Date(asked.getTime() - 60000).toISOString() };
    assert.equal(autoEnd(edit('a.cs'), old, later), false, 'a gate from before this timer does not end it');
    assert.equal(autoEnd(edit('a.cs'), { ...old, lastGateAt: later.toISOString(), lastGate: 4 }, later), false, 'a gate before the last edit does not end it');
    assert.equal(autoEnd(edit('a.cs'), { ...old, lastGateAt: later.toISOString(), lastGateVerdict: 'FAIL' }, later), false);
    assert.equal(autoEnd(edit('a.cs'), { ...old, lastGateAt: later.toISOString() }, later), true);
    assert.equal(readMarks(dir).pop().text, 'end (auto: the gate passed; the ship brief)');
    assert.equal(fs.existsSync(path.join(state, POINTER)), false, 'ended: no active timer');

    const next = autoStart(edit('a.cs', 'Write'), new Date(later.getTime() + 60000), { isCode });
    assert.ok(next && next !== dir, 'the next code edit after the end starts the next task timer');
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// 2026-11-11 (TUW-243): the automatic timer showed one step ("first code edit: 35 min"), ten minutes of a
// full suite on the test machine counted as waiting, and a report read long after the end kept growing.
test('stages mark themselves, a stage that goes on is named, and the report adds a stage together', async () => {
  const { createRequire } = await import('node:module');
  const { autoStart, autoStage, idle, resume } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const state = tmp(), repo = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const transcript = path.join(state, '.claude', 'projects', 'p', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const isCode = (f) => f.endsWith('.cs');
    const call = (tool_name, tool_input) => ({ session_id: SID, transcript_path: transcript, cwd: repo, tool_name, tool_input });
    const code = call('Edit', { file_path: path.join(repo, 'a.cs') });
    const run = (command) => call('Bash', { command });
    const t0 = new Date();
    const at = (min) => new Date(t0.getTime() + min * 60000);

    assert.equal(autoStage(code, at(0), { isCode }), '', 'no timer yet: nothing to mark');
    const dir = autoStart(code, at(0), { isCode });
    assert.equal(autoStage(code, at(1), { isCode }), '', 'the first code edit is the code stage already');
    assert.equal(autoStage(run('node C:/u/.claude/skills/gate/scripts/red-proof.mjs --repo C:/r --then-green -- dotnet test'), at(5)), 'proof');
    assert.equal(autoStage(run('node C:/u/.claude/skills/gate/scripts/red-proof.mjs --repo C:/r --then-green -- dotnet test'), at(6)), '', 'the same stage twice adds nothing');
    assert.equal(autoStage(run('ls C:/u/red-proof.mjs.bak; echo evidence.mjs'), at(6)), '', 'a name in other text is not a stage');
    // 2026-11-11: work on the scripts themselves (git add, cmp, a grep) read as a 23-minute proof.
    assert.equal(autoStage(run('git add skills/gate/scripts/pre-review.mjs skills/gate/scripts/evidence.mjs x.md && grep -n a skills/gate/scripts/pre-review.mjs'), at(6)), '', 'a script that is only named is not run');
    assert.equal(autoStage(run('cd C:/r && "C:/Program Files/nodejs/node.exe" "C:/u/.claude/skills/gate/scripts/red-proof.mjs" --repo C:/r'), at(6)), '', 'the same stage, by the full path of node');
    assert.equal(autoStage(code, at(8), { isCode }), 'code', 'a fix after the proof is the code stage again');
    assert.equal(autoStage(run('node ~/.claude/skills/gate/scripts/pre-review.mjs --was small'), at(10)), 'checks before review');
    assert.equal(autoStage(run('node C:/u/.claude/skills/gate/scripts/evidence.mjs --spec full.json'), at(11)), 'tests');
    assert.equal(idle(call('Bash', {}), at(12), { busy: true }), false, 'a stop while the suite runs is not waiting');
    assert.equal(autoStage(call('Agent', { prompt: 'You are the independent reviewer — FRESH EYES' }), at(21)), 'review');
    assert.equal(autoStage(call('Agent', { prompt: 'Seat: Test designer.' }), at(21)), '', 'another helper is no stage');
    assert.equal(idle(call('Bash', {}), at(25)), true);
    assert.equal(resume(call('Bash', {}), at(30)), true);
    assert.equal(readMarks(dir).pop().text, 'resumed: review');
    mark(dir, 'wait', 'the user is checking', at(32));
    assert.equal(autoStage(run('node C:/u/.claude/skills/gate/scripts/evidence.mjs --spec full.json'), at(40)), 'tests', 'work after a wait marked by hand ends it');
    mark(dir, 'step', 'end (auto: the gate passed; the ship brief)', at(50));

    const text = report(dir, at(500));
    assert.match(text, /0\.0 min {2}end \(auto/, 'the end mark takes no time, however late the report is read');
    assert.match(text, /50 min {2}total \(work 37, waiting 13\)/);
    // code 0-5 and 8-10 · proof 5-8 · checks 10-11 · tests 11-21 and 40-50 · review 21-25 and 30-32 · waiting 25-30 and 32-40
    assert.match(text, /^by stage \(min\): tests 20 · waiting 13 · code 7\.0 · review 6\.0 · proof 3\.0 · checks before review 1\.0$/m, 'the first code edit is the code stage');
    // The reading before the first edit is its own stage.
    const planned = tmp();
    mark(planned, 'step', "start (auto): the user's message — repo", at(0));
    mark(planned, 'step', 'first code edit', at(3));
    mark(planned, 'step', 'proof', at(10));
    mark(planned, 'step', 'code', at(12));
    assert.match(report(planned, at(15)), /^by stage \(min\): code 10 · read and plan 3\.0 · proof 2\.0$/m);
    fs.rmSync(planned, { recursive: true, force: true });
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// 2026-11-11: an edit in another repository (`cd <dir> && sed -i …`) started a timer named after the
// session's own project.
test('a shell edit after `cd <dir> &&` starts the timer of that folder\'s repository', async () => {
  const { createRequire } = await import('node:module');
  const { autoStart } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const state = tmp(), session = tmp(), other = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    for (const r of [session, other]) execFileSync('git', ['init', '-q'], { cwd: r });
    fs.mkdirSync(path.join(other, 'src'));
    fs.writeFileSync(path.join(other, 'src', 'a.cs'), 'class A {}\n');
    const transcript = path.join(state, '.claude', 'projects', 'p', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const there = other.split(path.sep).join('/');
    const dir = autoStart({ session_id: SID, transcript_path: transcript, cwd: session, tool_name: 'Bash', tool_input: { command: `cd ${there} && sed -i 's/A/B/' src/a.cs` } },
      new Date(), { isCode: (f) => f.endsWith('.cs') });
    assert.ok(dir, 'the edit starts a timer');
    assert.ok(path.basename(dir).endsWith('-' + path.basename(other)), `${path.basename(dir)} is named after ${path.basename(other)}, not ${path.basename(session)}`);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    for (const d of [state, session, other]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// 2026-11-11: the report of a task showed no review time. A review runs beside the other stages, so it is
// listed apart and never added to the total.
test('a finished review goes on the timer once, beside the stages, and the report lists it apart', async () => {
  const { createRequire } = await import('node:module');
  const { sideReviews, idle, resume, autoStage } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const state = tmp(), notes = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    const real = { session_id: SID, transcript_path: path.join(state, '.claude', 'projects', 'p', 'session.jsonl') };
    const t0 = new Date();
    const at = (min) => new Date(t0.getTime() + min * 60000);
    mark(notes, 'step', 'proof', at(0));
    mark(notes, 'step', 'tests', at(4));
    fs.writeFileSync(path.join(state, POINTER), notes);
    const scan = { reviews: [
      { launchAt: at(-30).toISOString(), doneAt: at(-20).toISOString() },   // an older task's review
      { launchAt: at(3).toISOString(), doneAt: at(6.5).toISOString() },
      { launchAt: at(3).toISOString(), doneAt: '' },                         // no end: not finished
    ] };

    assert.equal(sideReviews({ transcript_path: path.join(state, 'fake.jsonl') }, scan, at(7)), 0, 'a hook test run never marks');
    assert.equal(sideReviews(real, scan, at(7)), 1, 'only the review of this task');
    assert.equal(sideReviews(real, scan, at(8)), 0, 'once');
    scan.reviews.push({ launchAt: at(9).toISOString(), doneAt: at(10).toISOString() });
    assert.equal(sideReviews(real, scan, at(11)), 1, 'a re-check after the fix is a second review');

    // The side lines are not moments of the timeline: a stop after them still starts a wait, and the stage goes on.
    assert.equal(idle(real, at(12)), true);
    assert.equal(resume(real, at(14)), true);
    assert.equal(readMarks(notes).filter(m => m.kind !== 'side').pop().text, 'resumed: tests');
    assert.equal(autoStage({ ...real, tool_name: 'Bash', tool_input: { command: 'node C:/u/.claude/skills/gate/scripts/evidence.mjs --spec x.json' } }, at(15)), '', 'still the tests stage');

    const text = report(notes, at(16));
    assert.match(text, /^ {2}3\.5 min {2}BESIDE review \(it ran beside the stages above; not added to the total\)$/m);
    assert.match(text, /^ {2}1\.0 min {2}BESIDE review /m);
    assert.match(text, /^ {3}16 min {2}total \(work 14, waiting 2\.0\)$/m, 'the reviews add nothing to the total');
    assert.match(text, /^by stage \(min\): tests 10 · proof 4\.0 · waiting 2\.0 · review 4\.5 \(beside\)$/m);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
  }
});

// 2026-11-17 (audit S7): the timer's start was the last message before the first edit, so the time before
// the user's "go" was lost and no report said how long the plan took. The start is the task's first request
// now (hooks/tests/timer-first-request.test.mjs), and the report names it.
test('the report names the first request and the minutes before the first edit', () => {
  const dir = tmp(), late = tmp(), byHand = tmp();
  try {
    mark(dir, 'step', "start (auto): the user's message — repo", at('10:00'));
    mark(dir, 'step', 'first code edit', at('10:21'));
    mark(dir, 'step', 'proof', at('10:30'));
    mark(dir, 'step', 'end (auto: the gate passed; the ship brief)', at('10:40'));
    // The time of day is shown where the report is read. The command runs in UTC here, so the line is known.
    const lines = execFileSync(process.execPath, [script, 'report', dir], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim().split(/\r?\n/);
    assert.equal(lines.pop(), 'start: first request 10:00 · first edit after 21 min');
    assert.ok(lines.includes('   40 min  total (work 40, waiting 0.0)'), 'the total line stays as it was');
    // In this process the clock is this machine's own.
    const local = `${String(at('10:00').getHours()).padStart(2, '0')}:${String(at('10:00').getMinutes()).padStart(2, '0')}`;
    assert.match(report(dir, at('11:00')), new RegExp(`^start: first request ${local} · first edit after 21 min$`, 'm'));

    // A guessed start says so; a wait for the go is waiting, and the request command names the session's start.
    const guess = tmp();
    try {
      mark(guess, 'step', "start (auto, estimate): the user's message — repo", at('10:00'));
      mark(guess, 'wait', 'waiting for the user', at('10:03'));
      mark(guess, 'step', "resumed: start (auto, estimate): the user's message — repo", at('10:20'));
      mark(guess, 'step', 'first code edit', at('10:21'));
      const g = report(guess, at('10:30'));
      assert.match(g, /waiting 17\)/);
      assert.match(g, /^start: first request \d\d:\d\d \(estimate\) · first edit after 21 min$/m);
      assert.match(g, /read and plan 4\.0/);
    } finally { fs.rmSync(guess, { recursive: true, force: true }); }
    // A timer that began at the first edit, or by hand, knows no first request: no such line.
    mark(late, 'step', 'start (auto): first code edit — repo', at('10:21'));
    mark(late, 'step', 'proof', at('10:30'));
    assert.doesNotMatch(report(late, at('10:40')), /^start:/m);
    mark(byHand, 'step', 'read the ticket', at('10:00'));
    mark(byHand, 'step', 'first code edit', at('10:21'));
    assert.doesNotMatch(report(byHand, at('10:40')), /^start:/m);
  } finally {
    for (const d of [dir, late, byHand]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// A session of its own for the two tests below: a git repository, a transcript where a real one sits, and
// the first code edit of the next piece of work at 10:21.
function nextEdit(state, repo, messages) {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const transcript = path.join(state, '.claude', 'projects', 'p', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, messages.map(([hhmm, content]) => JSON.stringify({ type: 'user', timestamp: at(hhmm).toISOString(), message: { role: 'user', content } })).join('\n') + '\n');
  return { session_id: SID, transcript_path: transcript, cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.cs') } };
}
// The waits for the user's go sit between the two marks and are left out here (timer-first-request.test.mjs).
const startedAt = (dir, hhmm, repo) => assert.deepEqual(readMarks(dir).filter((m) => m.kind === 'step' && !m.text.startsWith('resumed')).slice(0, 2).map((m) => [m.at.toISOString(), m.text]), [
  [at(hhmm).toISOString(), `start (auto, estimate): the user's message — ${path.basename(repo)}`],
  [at('10:21').toISOString(), 'first code edit'],
]);

// 2026-11-17 (audit S7): the next task must not start at a message of the task before. A timer ended by
// hand (`sanad-timer.mjs end`) is the timer before, as one the hooks ended is.
test('a timer ended by hand: the next task starts at the first message after its end', async () => {
  const { createRequire } = await import('node:module');
  const { autoStart } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const { setActive, clearActive } = await import('../scripts/sanad-timer.mjs');
  const state = tmp(), notes = tmp(), repo = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    // Task one was asked 20 minutes before the next request: only its end sets the two apart.
    const edit = nextEdit(state, repo, [['09:30', 'task one: fix the login'], ['09:50', 'next: the report page'], ['10:15', 'go']]);
    // What `end` does, at a known time: the end mark, then no active timer.
    mark(notes, 'step', 'build', at('09:31'));
    setActive(notes, at('09:31'));
    mark(notes, 'step', 'end', at('09:40'));
    clearActive(notes);
    assert.equal(fs.existsSync(path.join(state, POINTER)), false, 'ended: no active timer');
    startedAt(autoStart(edit, at('10:21'), { isCode: (f) => f.endsWith('.cs') }), '09:50', repo);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    for (const d of [state, notes, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('other work in the middle of a paused task starts at the message that asked for it', async () => {
  const { createRequire } = await import('node:module');
  const { autoStart } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
  const { setActive, pause, resume } = await import('../scripts/sanad-timer.mjs');
  const state = tmp(), notes = tmp(), repo = tmp();
  const before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    const edit = nextEdit(state, repo, [['09:50', 'task one: fix the login'], ['10:09', 'first fix the hook, then go on'], ['10:20', 'go']]);
    mark(notes, 'step', 'build', at('09:51'));
    setActive(notes, at('09:51'));
    pause(notes, 'hook fix', at('10:10'));
    // Not 09:50 (the paused task's own request, 19 minutes before) and not 10:20 (the go).
    const dir = autoStart(edit, at('10:21'), { isCode: (f) => f.endsWith('.cs') });
    startedAt(dir, '10:09', repo);
    // The paused task goes on as before: its timer is the active one again, and the other work waits.
    assert.equal(resume(notes, at('10:30')), 'build');
    assert.equal(path.resolve(fs.readFileSync(path.join(state, POINTER), 'utf8')), path.resolve(notes));
    assert.equal(readMarks(dir).pop().text, `paused: other task (${path.basename(notes)})`);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    for (const d of [state, notes, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// 2026-11-19 (P7): one task per timer, and the overhead as a number.
const cli = (state, args, extra = {}) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, SANAD_STATE_DIR: state, ...extra } });
const write = (dir, rows) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'timer.tsv'), rows.map(([t, k, w]) => `${at(t).toISOString()}\t${k}\t${w}`).join('\n') + '\n'); };

test('request ends the active timer of the session, and the end mark does not count as work', () => {
  const state = tmp(), notes = tmp();
  try {
    cli(state, ['mark', notes, 'proof']);
    const out = cli(state, ['request']);
    assert.match(out, /the timer before .* was ended/);
    assert.equal(readMarks(notes).pop().text, 'end (auto: a new task was routed)');
    // 2026-11-20: the new task has its own active timer at once, with the start mark.
    const fresh = fs.readFileSync(path.join(state, POINTER), 'utf8').trim();
    assert.notEqual(path.resolve(fresh), path.resolve(notes));
    assert.match(readMarks(fresh)[0].text, /^start: the user's request — /);
    // The ended timer stays named as the timer before.
    assert.equal(path.resolve(fs.readFileSync(path.join(state, 'sanad-timer-last-' + SID), 'utf8').trim()), path.resolve(notes));
  } finally { for (const d of [state, notes]) fs.rmSync(d, { recursive: true, force: true }); }
});

// 2026-11-20: a task in another work tree than the session's folder ran 45 minutes with no timer of its own.
test('request starts the new timer itself: named after --repo, the active one, and report reads it', () => {
  const state = tmp(), notes = tmp(), repo = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    cli(state, ['mark', notes, 'proof']);
    const out = cli(state, ['request', '--repo', repo]);
    assert.match(out, /the timer before .* was ended/);
    const fresh = fs.readFileSync(path.join(state, POINTER), 'utf8').trim();
    assert.equal(path.basename(fresh).slice(16), path.basename(repo).replace(/[^A-Za-z0-9_.-]/g, '_'), 'named after the task repo, not the session folder');
    assert.equal(path.basename(path.dirname(fresh)), 'timers');
    const first = readMarks(fresh)[0];
    assert.equal(first.text, `start: the user's request — ${path.basename(repo)}`);
    assert.ok(Math.abs(Date.now() - first.at.getTime()) < 60000);
    // report with no folder shows the new timer, not the old one.
    const rep = cli(state, ['report']);
    assert.ok(rep.includes(`TIMER folder: ${path.resolve(fresh)}`), rep);
    assert.ok(!rep.includes(path.resolve(notes)), rep);
    // No request file is left for a later task to read.
    assert.equal(fs.existsSync(path.join(state, 'sanad-task-start-' + SID)), false);
  } finally { for (const d of [state, notes, repo]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('a start that follows a fresh request keeps that request timer', () => {
  const state = tmp(), before = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    const first = requestStart(new Date(Date.now() - 600000)).dir;
    const again = requestStart(new Date(), { unlessFresh: true });
    assert.equal(again.dir, first);
    assert.equal(again.ended, '');
    assert.equal(readMarks(first).length, 1);
  } finally { process.env.SANAD_STATE_DIR = before; fs.rmSync(state, { recursive: true, force: true }); }
});

test('a second request with nothing running starts a timer and ends nothing', () => {
  const state = tmp();
  try {
    cli(state, ['request']);
    const out = cli(state, ['request']);
    assert.match(out, /the timer before/);   // the first request's timer was the active one
    fs.rmSync(path.join(state, POINTER));
    assert.doesNotMatch(cli(state, ['request']), /ended/);
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test('report with no folder reads this session timer and names it; another session does not', () => {
  const state = tmp(), notes = tmp();
  try {
    cli(state, ['mark', notes, 'build']);
    const out = cli(state, ['report']);
    assert.ok(out.includes(`TIMER folder: ${path.resolve(notes)}`), out);
    assert.match(out, /build/);
    assert.match(cli(state, ['report'], { CLAUDE_CODE_SESSION_ID: 'other-session' }), /no timer for this session/);
  } finally { for (const d of [state, notes]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('workflow minutes = work minus read and plan and code', () => {
  const dir = tmp();
  write(dir, [['10:00', 'step', "start (auto): the user's message — r"], ['10:05', 'step', 'first code edit'], ['10:08', 'step', 'code'],
    ['10:08', 'step', 'checks before review'], ['10:10', 'step', 'proof'], ['10:11', 'step', 'end']]);
  // 5 read, 3 code (first edit + code), 2 checks, 1 proof = work 11, minus 8 = 3.0
  assert.match(report(dir, at('10:30')), /workflow minutes 3\.0 \(work 11/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-22 (owner): no time limit and no time target. The timer measures and reports minutes per stage;
// nothing is called late, over or slow.
test('a long stage is reported in minutes and never called over, late or slow', () => {
  const dir = tmp();
  write(dir, [['10:00', 'step', 'proof'], ['10:45', 'step', 'review'], ['11:30', 'step', 'end']]);
  const text = report(dir, at('12:00'));
  assert.match(text, /^ +45 min {2}proof$/m);
  assert.match(text, /^ +45 min {2}review$/m);
  assert.doesNotMatch(text, /\bOVER\b|budget|\blate\b|\bslow\b|target/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('proof runs are counted per tool and per tree', () => {
  const dir = tmp();
  write(dir, [['10:00', 'step', 'code'], ['10:01', 'side', 'run proof aaa'], ['10:02', 'side', 'run proof aaa'], ['10:03', 'side', 'run proof bbb'], ['10:04', 'step', 'end']]);
  assert.match(report(dir, at('10:30')), /proof: 3 runs on 2 trees/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('week adds up the timers of the last 7 days only', () => {
  const root = tmp();
  write(path.join(root, 'a'), [['10:00', 'step', 'code'], ['10:04', 'step', 'proof'], ['10:06', 'step', 'end']]);
  const old = path.join(root, 'old');
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'timer.tsv'), '2026-10-01T10:00:00.000Z\tstep\tcode\n2026-10-01T10:30:00.000Z\tstep\tend\n');
  const text = week(root, new Date('2026-11-10T00:00:00Z'));
  assert.match(text, /WEEK: 1 timers · work 6\.0 min · workflow 2\.0 min · proof 2\.0 min/);
  fs.rmSync(root, { recursive: true, force: true });
});
