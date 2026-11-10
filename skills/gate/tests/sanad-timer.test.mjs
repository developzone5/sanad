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
    const real = { transcript_path: path.join(state, '.claude', 'projects', 'x', 'session.jsonl') };
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
    assert.equal(fs.existsSync(path.join(state, 'sanad-timer-active')), false);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
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
    fs.writeFileSync(path.join(state, 'sanad-timer-active'), notes);
    assert.equal(idle({ transcript_path: '/home/u/.claude/projects/p/s.jsonl' }, new Date('2026-01-02T00:00:00Z')), false);
  } finally {
    if (before === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(notes, { recursive: true, force: true });
  }
});
