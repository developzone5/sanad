import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mark, readMarks, report } from '../scripts/sanad-timer.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sanad-timer.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-timer-'));
const at = (hhmm) => new Date(`2026-11-09T${hhmm}:00Z`);
// One session for the whole file (each test file runs in its own process): the timer script and the hooks
// both name the active timer after it.
const SID = 'test-session';
process.env.CLAUDE_CODE_SESSION_ID = SID;
const POINTER = 'sanad-timer-active-' + SID;

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
  const { autoStart, autoEnd, lastPromptAt } = createRequire(import.meta.url)('../../../hooks/lib/timer-idle.cjs');
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
    assert.equal(lastPromptAt(transcript).toISOString(), asked.toISOString(), 'hook notes and tool results are not the user');
    // The temp folder never counts as code in a real session, so the test names what does.
    const isCode = (f) => f.endsWith('.cs');
    const edit = (file, tool = 'Edit') => ({ session_id: SID, transcript_path: transcript, cwd: repo, tool_name: tool, tool_input: { file_path: path.join(repo, file) } });

    assert.equal(autoStart(edit('README.md'), now, { isCode }), null, 'not a code file: no timer');
    assert.equal(autoStart({ ...edit('a.cs'), transcript_path: path.join(state, 'fake.jsonl') }, now), null, 'a hook test run never starts one');
    const dir = autoStart(edit('a.cs'), now, { isCode });
    assert.ok(dir && dir.startsWith(path.join(state, 'timers')), String(dir));
    assert.deepEqual(readMarks(dir).map(m => [m.at.toISOString(), m.text]), [
      [asked.toISOString(), `start (auto): the user's message — ${path.basename(repo)}`],
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
