// The re-check of the PR 3 attack fixes (2026-11-22): the cases it found, each held by a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reopensRound } from '../scripts/steps.mjs';
import { addPin, readPins } from '../scripts/notes-dir.mjs';
import { reviewLine } from '../scripts/notes.mjs';
import { collectNotes } from '../scripts/note-check.mjs';
import { holdTestMachine } from '../scripts/test-machine-lock.mjs';

const scan = createRequire(import.meta.url)('../../../hooks/lib/transcript-scan.js');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-recheck-')));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const id = (c) => c.repeat(40);

test('a security note opens a round past the limit: AuthMiddleware, JWT, authorization; "author" and "accessible" do not', () => {
  for (const text of ['Bug — AuthMiddleware accepts expired JWTs', 'Gap — the authorization check is skipped', 'Bug — a teacher gets access to another tenant']) assert.equal(reopensRound({ kind: 'Bug', text }), true, text);
  for (const text of ['Bug — author-name sorting is wrong', 'Bug — the authored-by column is empty', 'Bug — an accessible label is missing']) assert.equal(reopensRound({ kind: 'Bug', text }), false, text);
});

test('a round written again (the brief made twice) keeps its first note count', () => {
  const notes = path.join(root, 'pins');
  fs.mkdirSync(notes);
  const pin = { kind: 'full', commit: id('a'), tree: id('b'), mergeBase: id('c'), seats: ['fresh eyes'], frozen: '', noteCount: 2 };
  addPin(notes, pin);
  addPin(notes, { ...pin, noteCount: 5 });
  assert.deepEqual(readPins(notes).map((p) => [p.round, p.noteCount]), [[1, 2]]);
  addPin(notes, { ...pin, commit: id('d'), kind: 'recheck', noteCount: 5 });
  assert.deepEqual(readPins(notes).map((p) => [p.round, p.noteCount]), [[1, 2], [2, 5]]);
});

test('"Bug: none." is no bug in the REVIEW line, and the note check gets nothing to check for it', () => {
  const line = reviewLine([{ n: 1, kind: 'Bug', state: 'none' }, { n: 2, kind: 'Bug', state: 'fixed' }], { goals: 1 });
  assert.match(line.line, /^REVIEW: PASS — bugs 1\/1,/);
  const file = path.join(root, 'review-a.md');
  fs.writeFileSync(file, 'RECOMMEND: FAIL\n\nEXTRA TEST: none.\nBug: none.\nGap — a.ts:3 — no test for 0\n');
  assert.deepEqual(collectNotes([file], scan.reportNotes).map((k) => k.kind), ['Gap']);
});

test('a lock file that cannot be written stops the run: it never goes on unlocked', async () => {
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'a file where the state folder should be');
  const keep = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = blocked;
  try {
    const said = [];
    assert.equal(await holdTestMachine('pc2', 'check', 'evidence', { say: (l) => said.push(l) }), null);
    assert.match(said[0], /^TEST MACHINE: the lock file .* cannot be written .* this run stops and does not run unlocked\./);
  } finally { process.env.SANAD_STATE_DIR = keep; }
});
