import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ticketLines, renderLines } from '../scripts/lines.mjs';
import { readLines } from '../scripts/check-ticket-lines.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lines.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

// 2026-11-13: the lines file was typed by hand at the start of every task.
test('every non-empty ticket line becomes T<n>, words untouched; heading and bullet marks are dropped', () => {
  const text = '## Steps\r\n- Open the exam.\n\n  * Wait for Part 1 to end.  \nExpected: "Part 1 ended, moved to Part 2."\n• انتهى وقت الجزء الأول\n';
  assert.deepEqual(ticketLines(text), ['Steps', 'Open the exam.', 'Wait for Part 1 to end.', 'Expected: "Part 1 ended, moved to Part 2."', 'انتهى وقت الجزء الأول']);
  const file = renderLines(ticketLines(text), { date: new Date('2026-11-13T10:00:00Z') });
  assert.match(file, /^# Lines \(the ticket, verbatim, 2026-11-13\)\n\nT1\. Steps\nT2\. Open the exam\.\n/);
  // The checks read it back as the same lines.
  assert.deepEqual(readLines(file).slice(0, 2), ['T1: Steps', 'T2: Open the exam.']);
  assert.match(renderLines(['x'], { noTicket: true }), /^# Lines \(no ticket: the user's own words, /);
});

test('the command writes lines.md and ticket.md beside it; a missing or empty file is a usage error', () => {
  const from = path.join(root, 'ticket.txt');
  fs.writeFileSync(from, 'Title line\n\nExpected: once\n');
  const out = path.join(root, 'notes', 'lines.md');
  const r = run(['--from', from, '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^LINES: 2 line\(s\) T1\.\.T2 — /);
  assert.match(fs.readFileSync(out, 'utf8'), /^T2\. Expected: once$/m);
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'ticket.md'), 'utf8'), 'Title line\n\nExpected: once\n');
  assert.equal(run(['--from', path.join(root, 'none.txt'), '--out', out]).status, 2);
  fs.writeFileSync(path.join(root, 'blank.txt'), '\n  \n');
  assert.equal(run(['--from', path.join(root, 'blank.txt'), '--out', out]).status, 2);
  assert.equal(run(['--from', from, '--out', out, '--no-ticket']).status, 2, '--no-ticket needs --repo');
});
