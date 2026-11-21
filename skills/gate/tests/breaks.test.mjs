import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyBreak, breakHits } from '../scripts/red-proof.mjs';

const script = fileURLToPath(new URL('../scripts/breaks.mjs', import.meta.url));
const proof = fileURLToPath(new URL('../scripts/red-proof.mjs', import.meta.url));
const shellChars = 'قال "hello" \\$value ' + String.fromCharCode(96);
const oldTest = 'test("[C1] keeps the old rule", () => { assert.ok(true); });\n';
const newTitle = '[C1] keeps the new rule';
const newTest = 'test("' + newTitle + '", () => { assert.ok(true); });\n';
const empty = (name) => ({ name, file: '', find: '', put: '', mustFail: [name] });

function fixture(t, src = 'first line\nsecond line\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breaks-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project folder');
  const list = path.join(root, 'break list.json');
  const file = 'app source.cjs';
  const source = path.join(repo, file);
  fs.mkdirSync(repo);
  fs.writeFileSync(source, src);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'no-git-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', SANAD_STATE_DIR: path.join(root, 'state') };
  const run = (tool, args) => {
    const result = spawnSync(process.execPath, [tool, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  const cli = (command, args) => run(script, [command, '--repo', repo, '--breaks', list, ...args]);
  return {
    root, repo, list, file, source,
    add: (args = [], target = file, line = '1', mustFail = 'keeps the rule') => cli('add',
      ['--file', target, '--line', line, '--must-fail', mustFail, ...args]),
    seed: (base = 'HEAD') => cli('seed', ['--base', base]),
    check: () => run(proof, ['--repo', repo, '--breaks', list, '--base', 'HEAD', '--check-plan', '--',
      process.execPath, '-e', 'throw new Error("Must never run")']),
    read: () => JSON.parse(fs.readFileSync(list, 'utf8')),
  };
}

// Supply the history and index as fixture data. Every Git command can stay read-only.
function baseWithOldTest(repo) {
  const gitDir = path.join(repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
  const sha1 = data => createHash('sha1').update(data).digest();
  const object = (type, body) => {
    const bytes = Buffer.concat([Buffer.from(type + ' ' + body.length + '\0'), body]);
    const hash = sha1(bytes);
    const id = hash.toString('hex');
    const dir = path.join(gitDir, 'objects', id.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id.slice(2)), deflateSync(bytes));
    return hash;
  };
  const file = 'old.test.cjs';
  const blob = object('blob', Buffer.from(oldTest));
  const tree = object('tree', Buffer.concat([Buffer.from('100644 ' + file + '\0'), blob]));
  const who = 'Fixture <fixture@example.invalid> 1700000000 +0000\n';
  const commit = object('commit', Buffer.from('tree ' + tree.toString('hex') + '\nauthor ' + who +
    'committer ' + who + '\nFixture base\n'));
  fs.writeFileSync(path.join(gitDir, 'HEAD'), commit.toString('hex') + '\n');
  fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  // A version-2 index with one entry for the old test.
  const header = Buffer.from('444952430000000200000001', 'hex');
  const entry = Buffer.alloc(Math.ceil((62 + file.length + 1) / 8) * 8);
  entry.writeUInt32BE(0o100644, 24);
  entry.writeUInt32BE(Buffer.byteLength(oldTest), 36);
  blob.copy(entry, 40);
  entry.writeUInt16BE(file.length, 60);
  entry.write(file, 62);
  const data = Buffer.concat([header, entry]);
  const index = Buffer.concat([data, sha1(data)]);
  const indexPath = path.join(gitDir, 'index');
  fs.writeFileSync(indexPath, index);
  return { file: path.join(repo, file), indexPath, index };
}

function ok(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function refused(result, message) {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
}

test('add refuses repeated text and suggests a longer range', (t) => {
  const f = fixture(t, 'first line\nsecond line\nfirst line\nthird line\n');
  refused(f.add(['--put', 'change']), /matches 2 time\(s\).*--to/);
  assert.equal(fs.existsSync(f.list), false);
  ok(f.add(['--to', '2', '--put', 'change']));
  assert.equal(f.read()[0].find, 'first line\nsecond line');
});

test('add preserves mixed endings and shell characters in both find and put', (t) => {
  const find = '\uFEFFconst value = "' + shellChars + '";\r\nmiddle\nbottom';
  const src = find + '\r\nleave this line\n';
  const put = 'replacement: ' + shellChars + '\r\nanother line\n';
  const f = fixture(t, src);
  const putFile = path.join(f.root, 'replacement text.txt');
  fs.writeFileSync(putFile, put);
  const result = f.add(['--to', '3', '--put-file', path.basename(putFile)]);
  ok(result);
  const [entry] = f.read();
  assert.deepEqual(JSON.parse(result.stdout), entry);
  assert.equal(entry.file, f.file);
  assert.deepEqual(Buffer.from(entry.find), Buffer.from(find));
  assert.deepEqual(Buffer.from(entry.put), Buffer.from(put));
  for (const text of [src, src.replace(/\r\n/g, '\n'), src.replace(/\r?\n/g, '\r\n')]) {
    assert.equal(breakHits(text, entry.find), 1);
    assert.ok(applyBreak(text, entry.find, entry.put).endsWith('leave this line' + (text.endsWith('\r\n') ? '\r\n' : '\n')));
  }
  assert.equal(fs.readFileSync(f.source, 'utf8'), src);
  assert.equal(fs.readFileSync(putFile, 'utf8'), put);
});

test('add appends and protects earlier entries from duplicate adds', (t) => {
  const f = fixture(t);
  const first = { name: 'earlier break', file: 'another.js', find: 'old', put: 'new', mustFail: ['earlier test'], extra: [1, '2'] };
  fs.writeFileSync(f.list, JSON.stringify([first]));
  ok(f.add(['--put', 'replacement']));
  assert.deepEqual(f.read(), [first, { name: 'keeps the rule', file: f.file, find: 'first line',
    put: 'replacement', mustFail: ['keeps the rule'] }]);
  const before = fs.readFileSync(f.list);
  refused(f.add(['--put', 'replacement']), /Break already exists/);
  assert.deepEqual(fs.readFileSync(f.list), before);
  ok(f.add(['--put', ''], f.file, '2', 'second test'));
  assert.equal(f.read()[2].put, '');
});

test('add checks bounds and keeps a partial multiline string exact', (t) => {
  const f = fixture(t, 'var message = """\r\n  inside\n  still inside\n  """;\n');
  for (const line of ['0', '-1', '1.5', '9007199254740992', '5']) {
    refused(f.add(['--put', 'remove'], f.file, line), /line number|outside/i);
  }
  refused(f.add(['--to', '1', '--put', 'remove'], f.file, '2'), /outside/);
  assert.equal(fs.existsSync(f.list), false);
  ok(f.add(['--to', '2', '--put', 'remove']));
  assert.equal(f.read()[0].find, 'var message = """\r\n  inside');
});

test('add refuses paths outside the repo, including a directory link', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'external');
  fs.mkdirSync(outside);
  const other = path.join(outside, 'private.cjs');
  fs.writeFileSync(other, 'outside the repo');
  refused(f.add(['--put', 'change'], '../external/private.cjs'), /inside the working tree/);
  refused(f.add(['--put', 'change'], other), /inside the working tree/);
  fs.symlinkSync(outside, path.join(f.repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(f.add(['--put', 'change'], 'linked/private.cjs'), /inside the working tree/);
  assert.equal(fs.existsSync(f.list), false);
});

test('add refuses a bad list, bad UTF-8, or conflicting replacement options', (t) => {
  const f = fixture(t);
  const invalid = '{"breaks":[]}';
  fs.writeFileSync(f.list, invalid);
  refused(f.add(['--put', 'replacement']), /JSON array/);
  refused(f.add(['--put', 'replacement', '--put-file', f.source]), /Supply one of --put or --put-file/);
  const bytes = Buffer.from([0xc3, 0x28]);
  fs.writeFileSync(f.source, bytes);
  refused(f.add(['--put', 'replacement']), /UTF-8/);
  assert.equal(fs.readFileSync(f.list, 'utf8'), invalid);
  assert.deepEqual(fs.readFileSync(f.source), bytes);
});

test('add leaves another writer’s lock and list alone', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.list, '[]');
  fs.writeFileSync(f.list + '.lock', 'someone else');
  refused(f.add(['--put', 'replacement']), /Break list is locked/);
  assert.equal(fs.readFileSync(f.list + '.lock', 'utf8'), 'someone else');
  assert.equal(fs.readFileSync(f.list, 'utf8'), '[]');
});

test('seed writes only new test titles and add can fill an exact slot', (t) => {
  const f = fixture(t);
  const base = baseWithOldTest(f.repo);
  fs.writeFileSync(base.file, oldTest + newTest);
  const untrackedTitle = 'يحفظ الاسم';
  fs.writeFileSync(path.join(f.repo, 'new ملف.test.mjs'),
    'test("' + untrackedTitle + '", () => { assert.ok(true); });\n' +
    'test.skip("skipped test", () => {});\n');
  const result = f.seed();
  ok(result);
  const entries = [empty(untrackedTitle), empty(newTitle)];
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines.pop(), 'Seeded 2 break(s).');
  assert.deepEqual(lines.map(line => JSON.parse(line)), entries);
  assert.deepEqual(f.read(), entries);
  assert.deepEqual(fs.readFileSync(base.indexPath), base.index);
  const check = f.check();
  assert.equal(check.status, 2, check.stdout + check.stderr);
  assert.match(check.stdout, /BREAK EMPTY .*keeps the new rule: its file, find, put are empty/);
  assert.match(f.seed().stdout, /^Seeded 0 break\(s\)\./);
  assert.deepEqual(f.read(), entries);
  entries[1].detail = 'author note';
  fs.writeFileSync(f.list, JSON.stringify(entries));
  const filled = f.add(['--put', 'replacement'], f.file, '1', newTitle);
  ok(filled);
  const expected = { ...entries[1], file: f.file, find: 'first line', put: 'replacement' };
  assert.deepEqual(JSON.parse(filled.stdout), expected);
  assert.deepEqual(f.read(), [entries[0], expected]);
});

test('seed refuses an unknown base and leaves the list intact', (t) => {
  const f = fixture(t);
  baseWithOldTest(f.repo);
  fs.writeFileSync(f.list, '[]');
  refused(f.seed('missing-base'), /No merge base with missing-base/);
  assert.equal(fs.readFileSync(f.list, 'utf8'), '[]');
});

test('the proof catches a must-fail fragment shared by an old test and a new one', (t) => {
  const f = fixture(t);
  const base = baseWithOldTest(f.repo);
  fs.writeFileSync(base.file, oldTest + newTest);
  ok(f.add(['--put', 'replacement'], f.file, '1', '[C1]'));
  const result = f.check();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /BREAK AMBIGUOUS .*\[C1\].*holds new test\(s\).*older test\(s\)/);
  fs.writeFileSync(f.list, '[]');
  ok(f.add(['--put', 'replacement'], f.file, '1', newTitle));
  const clear = f.check();
  ok(clear);
  assert.equal(clear.stdout.trimEnd().split(/\r?\n/).at(-1), 'PLAN OK');
  assert.deepEqual(fs.readFileSync(base.indexPath), base.index);
  assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
});
