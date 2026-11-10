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
    assert.equal(idle(real, now), true);
    assert.equal(idle(real, now), false, 'one wait at a time');
    assert.equal(resume(real, new Date(now.getTime() + 60000)), true);
    assert.deepEqual(readMarks(notes).map(m => [m.kind, m.text]), [['step', 'build'], ['wait', IDLE], ['step', 'resumed']]);

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
