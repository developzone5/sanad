// 2026-11-28 (owner, batch b task 1, items 5 and 6).
// Item 5: two proofs with one test command overwrote each other's entry, so a failed proof of one break was cleared by
// another break's pass. Both entries are kept now (entryKey), and a failed entry is cleared only by a newer passing run of
// its command that covers each of its breaks.
// Item 6: a narrower command never stands for a wider one: `npx vitest run` is not covered by `npx vitest run t/a.test.js`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as record from '../scripts/proof-record.mjs';

// On the copy before 2026-11-28 there is no entryKey: every proof of one command had the key of the command alone. The
// fallbacks let this file run there and fail on what it checks, not on a missing name.
const { recordKey, oldEntries, testFileHashes, writeEntry, readRecord } = record;
const entryKey = record.entryKey || ((command, cwd) => recordKey(command, cwd));
const siteIds = record.siteIds || (() => undefined);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-same-command-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
function folder(files) {
  const top = path.join(root, 'f' + (++n));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(top, f)), { recursive: true }); fs.writeFileSync(path.join(top, f), text); }
  return top;
}
const TODAY = 'a'.repeat(40);
const hash = (top, f) => testFileHashes(top, [f])[f];
const T1 = "it('[C1] shows the role', () => { expect(1).toBe(1); });\n";
const PRODUCT = { 'src/a.js': 'export const a = 1;\n' };
const A = { name: 'A', file: 'src/a.js', find: 'a = 1', put: 'a = 2', mustFail: ['shows the role'] };
const B = { name: 'B', file: 'src/a.js', find: 'export', put: '', mustFail: ['shows the role'] };
const CMD = ['npx', 'vitest', 'run'];
const passing = (top, { command = CMD, breaks = [A], at = '2026-11-28T05:00:00.000Z' } = {}) => ({ ok: true, breaks: breaks.length, code: TODAY, at, command, cwd: '', sites: siteIds(breaks),
  targets: { 'src/a.js': hash(top, 'src/a.js') }, files: { 't/a.test.js': hash(top, 't/a.test.js') }, caught: { 't/a.test.js': [{ line: 1, title: '[C1] shows the role', ran: 't/a.test.js > [C1] shows the role' }] } });
const failed = ({ breaks = [A], at = '2026-11-28T04:00:00.000Z' } = {}) => ({ ok: false, reason: 'a break was not caught', command: CMD, cwd: '', sites: siteIds(breaks), at });

test('item 5: two proofs of one command with other breaks get two entries; the same breaks keep one', () => {
  assert.notEqual(entryKey(CMD, '', [A]), entryKey(CMD, '', [B]));
  assert.equal(entryKey(CMD, '', [A, B]), entryKey(CMD, '', [B, A]), 'the order of the breaks does not matter');
  // Fixing only a break's test name keeps its spot, so its entry.
  assert.equal(entryKey(CMD, '', [A]), entryKey(CMD, '', [{ ...A, name: 'A2', mustFail: ['the role'] }]));
  assert.equal(entryKey(CMD, '', []), recordKey(CMD, ''), 'a proof with no break keeps the old key');
  // Written through the record writer, both stay.
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  process.env.SANAD_STATE_DIR = path.join(top, '.state');
  writeEntry(top, entryKey(CMD, '', [A]), failed());
  writeEntry(top, entryKey(CMD, '', [B]), passing(top, { breaks: [B] }));
  assert.equal(Object.keys(readRecord(top).entries).length, 2);
});

test('item 5: a failed proof of break A is never cleared by a pass of break B; a pass that covers A clears it', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const onlyB = { entries: { a: failed(), b: passing(top, { breaks: [B] }) } };
  const held = oldEntries(top, onlyB, TODAY).get('a');
  assert.equal(held.released, false);
  assert.match(held.why, /cover each of its breaks/);
  assert.equal(oldEntries(top, { entries: { a: failed(), ab: passing(top, { breaks: [A, B] }) } }, TODAY).get('a').released, true);
  // An older pass never clears a later failure.
  assert.equal(oldEntries(top, { entries: { a: failed({ at: '2026-11-28T06:00:00.000Z' }), ab: passing(top, { breaks: [A, B] }) } }, TODAY).get('a').released, false);
  // Another command never clears it.
  assert.equal(oldEntries(top, { entries: { a: failed(), ab: passing(top, { breaks: [A, B], command: ['npx', 'vitest', 'run', 't/a.test.js'] }) } }, TODAY).get('a').released, false);
  // An entry written before this change has no sites: a newer pass of its command clears it, as before.
  const legacy = { ...failed() };
  delete legacy.sites;
  assert.equal(oldEntries(top, { entries: { legacy, b: passing(top, { breaks: [B] }) } }, TODAY).get('legacy').released, true);
});

test('item 6: a test file added to a command that named none narrows it, and releases nothing', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const wide = { ...passing(top), code: 'b'.repeat(40), at: '2026-11-28T04:00:00.000Z' };
  const narrow = passing(top, { command: ['npx', 'vitest', 'run', 't/a.test.js'] });
  const r = oldEntries(top, { entries: { wide, narrow } }, TODAY).get('wide');
  assert.equal(r.released, false, JSON.stringify(r));
  assert.match(r.why, /ran every part of its command/);
  // A command that already named test files still widens with one more.
  const named = { ...wide, command: ['npx', 'vitest', 'run', 't/a.test.js'] };
  const wider = passing(top, { command: ['npx', 'vitest', 'run', 't/a.test.js', 't/b.test.js'] });
  assert.equal(oldEntries(top, { entries: { named, wider } }, TODAY).get('named').released, true);
  // The same wide command run again on today's code releases it.
  assert.equal(oldEntries(top, { entries: { wide, again: passing(top) } }, TODAY).get('wide').released, true);
});

// Review (task 1 PR): a runner script path or a flag's value names no test, so adding a test file still narrows.
test('item 6: a runner script path or a flag value is no named test file', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  for (const WIDE of [['C:/node20/node.exe', 'node_modules/vitest/vitest.mjs', 'run'], ['npx', 'vitest', 'run', '--root', './web']]) {
    const wide = { ...passing(top, { command: WIDE }), code: 'b'.repeat(40), at: '2026-11-28T04:00:00.000Z' };
    const narrow = passing(top, { command: [...WIDE, 't/a.test.js'] });
    assert.equal(oldEntries(top, { entries: { wide, narrow } }, TODAY).get('wide').released, false, WIDE.join(' '));
  }
  // A named folder (a trailing slash) still widens with one more file.
  const folderRun = { ...passing(top, { command: ['node', '--test', 't/'] }), code: 'b'.repeat(40), at: '2026-11-28T04:00:00.000Z' };
  assert.equal(oldEntries(top, { entries: { folderRun, more: passing(top, { command: ['node', '--test', 't/', 't/a.test.js'] }) } }, TODAY).get('folderRun').released, true);
});
