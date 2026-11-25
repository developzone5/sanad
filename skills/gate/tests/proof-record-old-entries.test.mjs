// 2026-11-25 (owner, old proof entries): an old entry of the proof record blocked the ready check after the code or the
// test command moved on, and a full proof ran again with no code change (run 3: one run; test 4: two). oldEntries()
// says which old entries stop blocking. The promise: "proof done" only when every test that still exists and that any
// entry ever proved is proved, by a passing entry, on the code as it is now; never early. A test is matched as today:
// its line and title on the file as it is now. No position matching across versions, no title-only matching.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oldEntries, testFileHashes, codeFingerprint } from '../scripts/proof-record.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-old-entries-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
// A folder with the given files (no git needed: the code id is given as TODAY).
function folder(files) {
  const top = path.join(root, 'f' + (++n));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(top, f)), { recursive: true }); fs.writeFileSync(path.join(top, f), text); }
  return top;
}
const TODAY = 'a'.repeat(40);
const hash = (top, f) => testFileHashes(top, [f])[f];
const T1 = "it('[C1] shows the role', () => { expect(1).toBe(1); });\n";
const T2 = "it('[C2] shows the name', () => { expect(2).toBe(2); });\n";
const T3 = "it('[C3] shows the date', () => { expect(3).toBe(3); });\n";
const PRODUCT = { 'src/a.js': 'export const a = 1;\n' };
// One passing entry: its breaks' tests (file → [[line, title]]), on `code`, at `at`.
function entry(top, tests, { code = TODAY, at = '2026-11-25T05:00:00.000Z', files } = {}) {
  const caught = Object.fromEntries(Object.entries(tests).map(([f, list]) => [f, list.map(([line, title, ran]) => ({ line, title, ran: ran ?? `${f} > ${title}` }))]));
  return { ok: true, breaks: 1, code, at, command: ['node', '--test'], cwd: '', targets: { 'src/a.js': hash(top, 'src/a.js') },
    files: files || Object.fromEntries(Object.keys(tests).map((f) => [f, hash(top, f)])), caught };
}
const OLD_AT = '2026-11-25T04:00:00.000Z', NEW_AT = '2026-11-25T05:00:00.000Z';

test('an old entry whose tests are all in a newer passing entry on today\'s code stops blocking (same test file)', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 + T2 });
  const record = { entries: {
    old: entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: OLD_AT }),
    wide: entry(top, { 't/a.test.js': [[1, '[C1] shows the role'], [2, '[C2] shows the name']] }, { at: NEW_AT }) } };
  const r = oldEntries(top, record, TODAY);
  assert.deepEqual([...r.keys()], ['old'], 'the entry on today\'s code is not an old entry');
  assert.equal(r.get('old').released, true, JSON.stringify(r.get('old')));
});

test('owner case 1: a rerun of one test file does not release a proof that covered that file and a folder', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1, 't/more/b.test.js': T2, 't/more/c.test.js': T3 });
  const record = { entries: {
    folder: entry(top, { 't/a.test.js': [[1, '[C1] shows the role']], 't/more/b.test.js': [[1, '[C2] shows the name']] }, { code: 'b'.repeat(40), at: OLD_AT }),
    oneFile: entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { at: NEW_AT }) } };
  const r = oldEntries(top, record, TODAY).get('folder');
  assert.equal(r.released, false);
  assert.deepEqual(r.files.map((f) => [f.file, f.released]), [['t/a.test.js', true], ['t/more/b.test.js', false]]);
  // The shape the last attempt released: the command ran a file and a folder, but its breaks caught tests in the file
  // only. A rerun of the file alone names every caught test, and still does not release it: it did not run the folder.
  const ranFolder = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: OLD_AT });
  ranFolder.command = ['node', '--test', 't/a.test.js', 't/more/'];
  const fileOnly = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { at: NEW_AT });
  fileOnly.command = ['node', '--test', 't/a.test.js'];
  const held = oldEntries(top, { entries: { ranFolder, fileOnly } }, TODAY).get('ranFolder');
  assert.equal(held.released, false);
  assert.match(held.why, /ran every part of its command/);
  // A newer proof that ran the folder too releases it.
  const both = { ...fileOnly, command: ['node', '--test', 't/a.test.js', 't/more/'] };
  assert.equal(oldEntries(top, { entries: { ranFolder, both } }, TODAY).get('ranFolder').released, true);
  // Another folder (cwd) is another run.
  assert.equal(oldEntries(top, { entries: { ranFolder, both: { ...both, cwd: 'web' } } }, TODAY).get('ranFolder').released, false);
});

test('owner case 2: a failed proof is not cleared by another proof that passed', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const record = { entries: {
    failed: { ok: false, reason: 'BREAK NOT CAUGHT', command: ['node', '--test', 't/a.test.js'], cwd: '', at: OLD_AT },
    other: entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { at: NEW_AT }) } };
  const r = oldEntries(top, record, TODAY).get('failed');
  assert.equal(r.released, false);
  assert.match(r.why, /only a passing run of its own command clears it/);
  // Also when the failed entry still holds the tests of the run before it (a hand-made record): ok false never releases.
  record.entries.failed = { ...entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: OLD_AT }), ok: false };
  assert.equal(oldEntries(top, record, TODAY).get('failed').released, false);
});

test('the test file changed: released only when every test the file has today is in a newer passing entry', () => {
  // The old entry saw the file before a test was added above its test: its line no longer fits today's file.
  const top = folder({ ...PRODUCT, 't/a.test.js': T2 + T1 });
  const before = 'f'.repeat(64);
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: OLD_AT, files: { 't/a.test.js': before } });
  // A newer entry that proved only one of today's two tests: not enough, by line and title on today's file.
  let record = { entries: { old, part: entry(top, { 't/a.test.js': [[2, '[C1] shows the role']] }, { at: NEW_AT }) } };
  let r = oldEntries(top, record, TODAY).get('old');
  assert.equal(r.released, false);
  assert.match(r.files[0].why, /1 of its 2 tests today are in no newer passing entry/);
  // Both of today's tests proved on the file as it is now: released.
  record = { entries: { old, all: entry(top, { 't/a.test.js': [[1, '[C2] shows the name'], [2, '[C1] shows the role']] }, { at: NEW_AT }) } };
  r = oldEntries(top, record, TODAY).get('old');
  assert.equal(r.released, true, JSON.stringify(r));
});

test('the test file changed: a test named by its printed name that no newer entry printed keeps the entry blocking', () => {
  // Test 4: a row of a test table was removed; the record cannot tell a removed test from one not proved.
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role', 'a > [C1] shows the role for Applicant']] }, { code: 'b'.repeat(40), at: OLD_AT, files: { 't/a.test.js': 'f'.repeat(64) } });
  const record = { entries: { old, now: entry(top, { 't/a.test.js': [[1, '[C1] shows the role', 'a > [C1] shows the role for Teacher']] }, { at: NEW_AT }) } };
  const r = oldEntries(top, record, TODAY).get('old');
  assert.equal(r.released, false);
  assert.match(r.files[0].why, /by their printed name/);
});

test('a printed name alone never releases: the same printed name on another line does not count', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 + T2 });
  const ran = 't/a.test.js > [C1] shows the role';
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role', ran]] }, { code: 'b'.repeat(40), at: OLD_AT });
  const record = { entries: { old, now: entry(top, { 't/a.test.js': [[2, '[C2] shows the name', ran]] }, { at: NEW_AT }) } };
  assert.equal(oldEntries(top, record, TODAY).get('old').released, false);
});

// Review (2026-11-25): a renamed test file is not gone. A missing file is released only when git, comparing the old
// entry's code tree with today's, reads it as deleted; with no way to tell, it keeps blocking.
test('a missing test file whose history git cannot read keeps the entry blocking', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: OLD_AT });
  old.caught['t/gone.test.js'] = [{ line: 1, title: '[C9] gone', ran: 'gone' }];
  old.files['t/gone.test.js'] = 'e'.repeat(64);
  const r = oldEntries(top, { entries: { old, now: entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { at: NEW_AT }) } }, TODAY).get('old');
  assert.deepEqual(r.files.map((f) => [f.file, f.released]), [['t/a.test.js', true], ['t/gone.test.js', false]]);
  assert.match(r.files[1].why, /git does not read it as deleted/);
  assert.equal(r.released, false);
});

test('git reads it: a deleted test file is released, a renamed one is not (its tests still exist)', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1, 't/gone.test.js': T2, 't/moved.test.js': T3 });
  const git = (...a) => execFileSync('git', a, { cwd: top, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('add', '-A');
  const before = codeFingerprint(top);
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']], 't/gone.test.js': [[1, '[C2] shows the name']] }, { code: before, at: OLD_AT });
  fs.rmSync(path.join(top, 't/gone.test.js'));
  git('add', '-A');
  let today = codeFingerprint(top);
  const now = () => entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: today, at: NEW_AT });
  let r = oldEntries(top, { entries: { old, now: now() } }, today).get('old');
  assert.deepEqual(r.files.map((f) => [f.file, f.released]), [['t/a.test.js', true], ['t/gone.test.js', true]], JSON.stringify(r));
  assert.equal(r.released, true);
  // A renamed test file: the same test under another name, not proved since.
  const renamed = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']], 't/moved.test.js': [[1, '[C3] shows the date']] }, { code: before, at: OLD_AT });
  fs.renameSync(path.join(top, 't/moved.test.js'), path.join(top, 't/renamed.test.js'));
  git('add', '-A');
  today = codeFingerprint(top);
  r = oldEntries(top, { entries: { renamed, now: now() } }, today).get('renamed');
  assert.equal(r.released, false);
  assert.deepEqual(r.files.map((f) => [f.file, f.released]), [['t/a.test.js', true], ['t/moved.test.js', false]]);
});

test('a row of an unchanged test table is not released by another row of the same line and title (review)', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const row = (who) => `t/a.test.js > [C1] shows the role for ${who}`;
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role', row('Applicant')], [1, '[C1] shows the role', row('Teacher')]] }, { code: 'b'.repeat(40), at: OLD_AT });
  let record = { entries: { old, now: entry(top, { 't/a.test.js': [[1, '[C1] shows the role', row('Teacher')]] }, { at: NEW_AT }) } };
  assert.equal(oldEntries(top, record, TODAY).get('old').released, false);
  record = { entries: { old, now: entry(top, { 't/a.test.js': [[1, '[C1] shows the role', row('Teacher')], [1, '[C1] shows the role', row('Applicant')]] }, { at: NEW_AT }) } };
  assert.equal(oldEntries(top, record, TODAY).get('old').released, true);
});

test('a changed file: another test with the same printed name but another title does not stand for the old row (review)', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 + "it('shows Applicant', () => {});\n" });
  const ran = 't/a.test.js > [C1] shows the role for Applicant';
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role', ran]] }, { code: 'b'.repeat(40), at: OLD_AT, files: { 't/a.test.js': 'f'.repeat(64) } });
  const record = { entries: { old, now: entry(top, { 't/a.test.js': [[1, '[C1] shows the role', 't/a.test.js > [C1] shows the role for Teacher'], [2, 'shows Applicant', ran]] }, { at: NEW_AT }) } };
  assert.equal(oldEntries(top, record, TODAY).get('old').released, false);
});

test('a newer command that adds anything but test files (an --exclude) did not run every part of the old one (review)', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: OLD_AT });
  old.command = ['node', '--test', 't/'];
  const narrowed = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { at: NEW_AT });
  narrowed.command = ['node', '--test', 't/', '--exclude', 't/more/**'];
  assert.equal(oldEntries(top, { entries: { old, narrowed } }, TODAY).get('old').released, false);
  narrowed.command = ['node', '--test', 't/', 't/x.test.js'];
  assert.equal(oldEntries(top, { entries: { old, narrowed } }, TODAY).get('old').released, true);
});

test('only a newer, counting entry releases: an older one, one on other code, or one whose break target changed does not', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const old = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { code: 'b'.repeat(40), at: NEW_AT });
  const same = { 't/a.test.js': [[1, '[C1] shows the role']] };
  // Older than the old entry (its time is earlier).
  assert.equal(oldEntries(top, { entries: { old, earlier: entry(top, same, { at: OLD_AT }) } }, TODAY).get('old').released, false);
  const later = '2026-11-25T06:00:00.000Z';
  // On other code than today's: it is an old entry itself and proves nothing today.
  assert.equal(oldEntries(top, { entries: { old, other: entry(top, same, { at: later, code: 'c'.repeat(40) }) } }, TODAY).get('old').released, false);
  // Its break target changed since it ran.
  const moved = entry(top, same, { at: later });
  moved.targets = { 'src/a.js': 'd'.repeat(64) };
  assert.equal(oldEntries(top, { entries: { old, moved } }, TODAY).get('old').released, false);
  // A newer entry that saw another version of the test file.
  const otherFile = entry(top, same, { at: later, files: { 't/a.test.js': 'd'.repeat(64) } });
  assert.equal(oldEntries(top, { entries: { old, otherFile } }, TODAY).get('old').released, false);
  // With no code id today nothing is released.
  assert.equal(oldEntries(top, { entries: { old, ok: entry(top, same, { at: later }) } }, '').get('old').released, false);
  // The counting entry: released.
  assert.equal(oldEntries(top, { entries: { old, ok: entry(top, same, { at: later }) } }, TODAY).get('old').released, true);
});

test('an old entry that names no test, a partial run, and an entry of the format before never stop blocking', () => {
  const top = folder({ ...PRODUCT, 't/a.test.js': T1 });
  const now = entry(top, { 't/a.test.js': [[1, '[C1] shows the role']] }, { at: '2026-11-25T06:00:00.000Z' });
  const r = oldEntries(top, { entries: { none: { ok: true, breaks: 1, code: 'b'.repeat(40), at: OLD_AT, caught: {} }, partial: { partial: true, at: OLD_AT },
    before: { ok: true, breaks: 2, files: {}, at: OLD_AT }, now } }, TODAY);
  for (const k of ['none', 'partial', 'before']) assert.equal(r.get(k).released, false, k);
});
