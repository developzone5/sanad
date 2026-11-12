import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, hasAuthority } from '../scripts/check-pr-body.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-pr-body.mjs');
const run = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-'));
  const file = path.join(dir, 'body.md');
  fs.writeFileSync(file, text);
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
};

test('a finding parked by the author is flagged', () => {
  const body = [
    '## Review',
    'Kept as they are by the author\'s decision: the error text still says "in steps of 0.25".',
    'A stored file mark above a since-lowered scale is still refused; no screen sends it.',
  ].join('\n');
  const found = check(body);
  assert.deepEqual(found.map((f) => f.line), [2, 3]);
  const r = run(body);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PARKED — line 2/);
  assert.match(r.stdout, /Only the user parks a finding/);
});

test('the same words pass with the user\'s or the ticket\'s own words quoted', () => {
  assert.ok(hasAuthority('Left as it is: the user said "leave it, only the comments fix" (2026-11-05).'));
  assert.ok(hasAuthority('Kept as is: TUW-160 says the last date "can\'t be set to a time that has passed".'));
  assert.equal(check('Known gap, accepted by the user: «a separate PR later».').length, 0);
  // A quote with no owner, or an owner with no quote, is not enough.
  assert.equal(check('Known gap: "rare in practice".').length, 1);
  assert.equal(check('Known gap, the user agreed.').length, 1);
});

test('a lead line passes only when every bullet under it quotes the user or the ticket', () => {
  const ok = ['Left as it is on purpose:', '- Input checks stay exact: TUW-160 says the last date "can\'t be set to a time that has passed".'].join('\n');
  assert.deepEqual(check(ok), []);
  const notOk = ['Pre-existing items left for a follow-up:', '- The parent home compares UTC with the device clock.', '- The at-risk count is date-window based.'].join('\n');
  assert.deepEqual(check(notOk).map((f) => f.line), [1]);
  const mixed = ['Kept as they are:', '- One: the user said "leave it".', '- Two: rare.'].join('\n');
  assert.equal(check(mixed).length, 1);
});

test('an ordinary body is clean', () => {
  const body = ['## Summary', 'Deadlines count by the minute.', '## Test plan', '- Full suite: 6622 passed, 0 failed.', '## Risk / migrations / config', 'None.'].join('\n');
  assert.deepEqual(check(body), []);
  const r = run(body);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PR BODY: clean/);
});

test('every parking phrase is caught, in any case', () => {
  for (const line of [
    'This is a pre-existing issue.',
    'Not fixed in this PR.',
    'WON\'T FIX for now.',
    'Left for a follow-up.',
    'Deferred to the next sprint.',
    'Accepted risk.',
    'No page reads them.',
    'Left as it is on purpose.',
  ]) assert.equal(check(line).length, 1, line);
});

// 2026-11-12 (audit C13): two apostrophes made a "quote" and the bare word "user" made it the user's, so
// "Known gap: the teacher's list doesn't refresh for the user." passed.
test('two apostrophes are not a quote, and the bare word "user" is not the user\'s words', () => {
  assert.equal(check("Known gap: the teacher's list doesn't refresh for the user.").length, 1);
  assert.equal(check('Known gap: "rare in practice" for the user.').length, 1);
  assert.equal(hasAuthority("Left as is: the user said 'leave it alone'."), false);
  assert.equal(hasAuthority("Kept as is: TUW-160's 'old rule' stays."), false);
});

test('the user\'s own words in double or typographic quotes still pass', () => {
  assert.deepEqual(check('Out of scope: the user said "only the export, nothing else" (2026-11-12).'), []);
  assert.deepEqual(check('Known gap, in the user\'s words: “leave the old list as it is”.'), []);
  assert.deepEqual(check('By design. User: "teachers never see drafts".'), []);
});

test('the other parking phrases are caught', () => {
  for (const line of [
    'Out of scope for this ticket.',
    'The order is by design.',
    'The old export is unchanged on purpose.',
    'The rename goes to a separate PR.',
    'A follow-up PR handles the AR text.',
    'Not in this PR: the parent view.',
  ]) assert.equal(check(line).length, 1, line);
});

test('a line that fixes an old problem is not parked', () => {
  assert.deepEqual(check('Fixes the pre-existing crash when the list is empty.'), []);
  assert.deepEqual(check('Fixed the existing race in the counter.'), []);
  assert.equal(check('Fixes the pre-existing crash; the other pre-existing bug stays.').length, 1);
});

test('usage errors exit 2', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
