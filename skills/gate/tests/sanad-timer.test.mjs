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
  assert.match(execFileSync(process.execPath, [script, 'report', dir], { encoding: 'utf8' }), /no marks yet/);
  execFileSync(process.execPath, [script, 'mark', dir, 'build', 'and', 'prove'], { encoding: 'utf8' });
  assert.match(execFileSync(process.execPath, [script, 'report', dir], { encoding: 'utf8' }), /build and prove/);
  fs.rmSync(dir, { recursive: true, force: true });
});
