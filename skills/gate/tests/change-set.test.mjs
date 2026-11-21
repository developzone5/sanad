import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changeSet, foreignLine, FOREIGN_LIMIT } from '../scripts/change-set.mjs';
import { changedFiles, allChangedPaths } from '../scripts/pre-review.mjs';
import { readDiff } from '../scripts/size-check.mjs';

// 2026-11-19: another session's untracked folder counted as 1,498 changed files and one check took 852 s; four
// tools each built their own list of changed files. One list now, with a FOREIGN? answer before any file is read.
const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'change-set-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// The machine's own git settings (a global ignore file, diff.renames) must not decide a test.
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const who of ['AUTHOR', 'COMMITTER']) { process.env[`GIT_${who}_NAME`] = 'Fixture'; process.env[`GIT_${who}_EMAIL`] = 'fixture@example.invalid'; }

let n = 0;
// A repository with a base commit (branch `base`) and the branch `task` checked out on it.
function fixture(files = { 'tracked.txt': 'one\n' }) {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (p, t = p + '\n') => { const f = path.join(repo, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  git('init', '-q', '-b', 'task');
  for (const [p, t] of Object.entries(files)) write(p, t);
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  return { repo, git, write };
}
const sorted = (list) => [...list].sort();
const many = (write, dir, count) => { for (let i = 0; i < count; i++) write(`${dir}f${i}.txt`, 'x\n'); };

// Tracked (committed and only edited), staged then edited again, untracked, ignored, deleted, renamed.
function mixed() {
  const f = fixture({
    '.gitignore': 'ignored.log\nbuild/\n', 'tracked.txt': 'one\n', 'edited.txt': 'one\n', 'gone.txt': 'bye\n',
    'old-name.txt': '1\n2\n3\n4\n5\n', 'moved.txt': '1\n2\n3\n4\n5\n6\n7\n8\n', 'src/keep.txt': 'keep\n',
  });
  f.write('tracked.txt', 'two\n'); f.write('committed-new.txt');
  f.git('add', '-A'); f.git('commit', '-qm', 'feat: one');
  f.write('edited.txt', 'two\n');
  f.write('staged.txt', 'staged\n'); f.git('add', 'staged.txt'); f.write('staged.txt', 'staged, then edited again\n');
  f.git('rm', '-q', 'gone.txt');
  f.git('mv', 'old-name.txt', 'new-name.txt');
  f.git('mv', 'moved.txt', 'moved-edited.txt'); f.write('moved-edited.txt', '1\n2\n3\n4\n5\n6\n7\nnine\n');
  f.write('untracked file.txt'); f.write('new dir/deep/b.txt'); f.write('src/new.test.ts', 'test\n');
  f.write('ignored.log'); f.write('build/out.txt');
  return f;
}
const MIXED = ['committed-new.txt', 'edited.txt', 'gone.txt', 'moved-edited.txt', 'new dir/deep/b.txt', 'new-name.txt', 'src/new.test.ts', 'staged.txt', 'tracked.txt', 'untracked file.txt'];

test('with no pin the list is the union the three tools build today, and each tool\'s own list is read from it', () => {
  const { repo } = mixed();
  const set = changeSet(repo, 'base');
  assert.deepEqual(sorted(set.files), MIXED);
  assert.equal(new Set(set.files).size, set.files.length, 'a file staged and then edited again is listed once');
  assert.deepEqual(set.deleted, ['gone.txt']);
  assert.deepEqual(set.untracked, ['new dir/deep/b.txt', 'src/new.test.ts', 'untracked file.txt']);
  assert.deepEqual(set.foreign, []);
  assert.equal(set.at, '');
  assert.match(set.mergeBase, /^[0-9a-f]{40}$/);
  assert.ok(!set.files.some(f => /ignored\.log|build\/|old-name|moved\.txt/.test(f)), 'no ignored file, and a renamed file under its new name only');

  // pre-review.mjs:83-89 (allChangedPaths): every changed path.
  const all = allChangedPaths(repo, 'base');
  assert.deepEqual(sorted(all), sorted(set.files));
  // pre-review.mjs:73-79 (changedFiles): the changed files that are still there.
  const present = changedFiles(repo, 'base');
  assert.deepEqual(sorted(present), sorted(set.files.filter(f => !set.deleted.includes(f))));
  // review-brief.mjs:622-624, its two commands word for word.
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const tracked = g('diff', '--name-only', '-z', set.mergeBase).split('\0').filter(Boolean);
  const untracked = g('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
  assert.deepEqual(sorted([...tracked, ...untracked.filter(f => !tracked.includes(f))]), sorted(set.files));
  assert.deepEqual(untracked, set.untracked);
  // size-check.mjs:166-217 (readDiff): files with lines, plus its pure renames ("old → new").
  const extra = {};
  const sized = [...readDiff(repo, 'base', extra).map(f => f.name), ...extra.renamed.map(r => r.split(' → ')[1]), ...extra.binary];
  assert.deepEqual(sorted(sized), sorted(set.files));
  // The four lists together are the list.
  const union = new Set([...all, ...present, ...tracked, ...untracked, ...sized]);
  assert.deepEqual(sorted(union), sorted(set.files));
});

test('two callers get the same answer: from a subfolder, and whatever diff.renames says', () => {
  const { repo, git } = mixed();
  const first = changeSet(repo, 'base');
  assert.deepEqual(changeSet(path.join(repo, 'src'), 'base'), first);
  git('config', 'diff.renames', 'false');
  assert.deepEqual(changeSet(repo, 'base'), first);
});

test('with a pin only that commit\'s files are listed; untracked and uncommitted work is named, never dropped', () => {
  const { repo, git, write } = mixed();
  const head = git('rev-parse', 'HEAD');
  const set = changeSet(repo, 'base', { at: 'HEAD' });
  assert.equal(set.at, head);
  assert.deepEqual(sorted(set.files), ['committed-new.txt', 'tracked.txt']);
  assert.deepEqual(set.deleted, []);
  assert.ok(set.untracked.includes('src/new.test.ts'), 'the untracked test file is named');
  assert.ok(!set.files.includes('src/new.test.ts'), 'and it is not in the pinned list');
  assert.deepEqual(sorted(set.uncommitted), ['edited.txt', 'gone.txt', 'moved-edited.txt', 'new-name.txt', 'staged.txt']);

  // Everything committed: the pin's list is the whole change, and nothing is left over.
  git('add', '-A'); git('commit', '-qm', 'feat: two');
  const all = changeSet(repo, 'base', { at: 'HEAD' });
  assert.deepEqual(sorted(all.files), MIXED);
  assert.deepEqual(all.deleted, ['gone.txt']);
  assert.deepEqual([all.untracked, all.uncommitted], [[], []]);
  // The earlier pin still answers for its own commit while the work goes on.
  write('tracked.txt', 'three\n');
  const old = changeSet(repo, 'base', { at: head });
  assert.deepEqual(sorted(old.files), ['committed-new.txt', 'tracked.txt']);
  assert.ok(old.uncommitted.includes('edited.txt') && old.uncommitted.includes('tracked.txt'), 'the work folder is not that commit, and the list says where');
  // With no pin, uncommitted is what differs from HEAD.
  assert.deepEqual(changeSet(repo, 'base').uncommitted, ['tracked.txt']);
  assert.throws(() => changeSet(repo, 'base', { at: 'no-such-ref' }), /--at no-such-ref is not a commit/);
  assert.throws(() => changeSet(repo, 'base', { at: '--output=x' }), /--at must be a git ref/);
});

test('a folder with 1,500 untracked files: a FOREIGN? answer in under 2 seconds that names the folder once', () => {
  const { repo, write } = fixture();
  write('src/mine.ts', 'export const a = 1;\n'); write('src/mine.test.ts', 'test\n');
  for (let i = 0; i < 1500; i++) write(`other-session/pkg${i % 30}/f${i}.txt`, 'x\n');
  const started = Date.now();
  const set = changeSet(repo, 'base');
  const ms = Date.now() - started;
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.equal(set.foreign.length, 1, JSON.stringify(set.foreign));
  assert.deepEqual({ dir: set.foreign[0].dir, count: set.foreign[0].count, repo: set.foreign[0].repo }, { dir: 'other-session/', count: 1500, repo: false });
  const exclude = fs.realpathSync.native(path.join(repo, '.git')).replace(/\\/g, '/') + '/info/exclude';
  assert.equal(set.foreign[0].exclude.toLowerCase(), exclude.toLowerCase());
  assert.equal(foreignLine(set.foreign), `FOREIGN? other-session/ holds 1500 untracked files: add it to ${set.foreign[0].exclude} if it is another session's, else commit it`);
  assert.equal(foreignLine(set), foreignLine(set.foreign), 'the change set itself gives the same line');
  assert.equal(foreignLine(set.foreign[0]), foreignLine(set.foreign));
  // The lists are still whole: the guard only says "stop", it hides nothing.
  assert.equal(set.untracked.length, 1502);
  // The same answer with a pin, and from a subfolder.
  assert.deepEqual(changeSet(repo, 'base', { at: 'HEAD' }).foreign, set.foreign);
  assert.deepEqual(changeSet(path.join(repo, 'src'), 'base').foreign, set.foreign);
  // The fix the line gives: the folder in the exclude file, and the task's own two files are the list again.
  fs.appendFileSync(set.foreign[0].exclude, 'other-session/\n');
  const after = changeSet(repo, 'base');
  assert.deepEqual(after.foreign, []);
  assert.deepEqual(after.files, ['src/mine.test.ts', 'src/mine.ts']);
});

test('200 untracked files: no refusal. 201: a refusal whose line gives the one fix for a real new feature', () => {
  const { repo, write } = fixture();
  assert.equal(FOREIGN_LIMIT, 200);
  many(write, 'new-feature/', 200);
  const ok = changeSet(repo, 'base');
  assert.deepEqual(ok.foreign, []);
  assert.equal(foreignLine(ok), '');
  assert.equal(ok.files.length, 200);
  write('new-feature/one-more.txt');
  const set = changeSet(repo, 'base');
  assert.deepEqual(set.foreign.map(f => [f.dir, f.count, f.repo]), [['new-feature/', 201, false]]);
  assert.match(foreignLine(set), /^FOREIGN\? new-feature\/ holds 201 untracked files: add it to .+\/info\/exclude if it is another session's, else commit it$/);
});

test('with more than 200 files the largest folders are named until 200 or fewer are left; scattered files name ./ once', () => {
  const a = fixture({ 'tracked.txt': 'one\n', 'src/keep.txt': 'keep\n' });
  many(a.write, 'big/', 150); many(a.write, 'mid/sub/', 40); many(a.write, 'src/', 30); a.write('top.txt');
  // 221 files: without big/ 71 are left, so big/ alone is named. New files in a tracked folder count under it.
  assert.deepEqual(changeSet(a.repo, 'base').foreign.map(f => [f.dir, f.count]), [['big/', 150]]);
  many(a.write, 'src/more/', 180);
  // 401 files: big/ and src/more/ go, 71 are left.
  assert.deepEqual(changeSet(a.repo, 'base').foreign.map(f => [f.dir, f.count]), [['src/more/', 180], ['big/', 150]]);

  const b = fixture();
  for (let i = 0; i < 204; i++) b.write(`d${i}/f.txt`, 'x\n');
  const scattered = changeSet(b.repo, 'base');
  assert.deepEqual(scattered.foreign.map(f => [f.dir, f.count]), [['./', 204]]);
  assert.match(foreignLine(scattered), /^FOREIGN\? \.\/ holds 204 untracked files: /);

  const c = fixture();
  many(c.write, '', 201);
  assert.deepEqual(changeSet(c.repo, 'base').foreign.map(f => [f.dir, f.count]), [['./', 201]]);
});

test('an untracked folder that is its own repository is foreign, even with 3 files', () => {
  const { repo, write } = fixture();
  write('mine.txt');
  const inner = path.join(repo, 'their-clone');
  fs.mkdirSync(inner);
  execFileSync('git', ['init', '-q'], { cwd: inner, windowsHide: true });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(inner, name), 'x\n');
  const set = changeSet(repo, 'base');
  assert.deepEqual(set.foreign.map(f => [f.dir, f.count, f.repo]), [['their-clone/', null, true]]);
  assert.match(foreignLine(set), /^FOREIGN\? their-clone\/ is its own repository: add it to .+\/info\/exclude if it is another session's, else move it out or add it as a submodule$/);
  assert.ok(set.untracked.includes('their-clone/') && set.untracked.includes('mine.txt'), 'git names the folder once and does not look inside');
  // With more than 200 other files both answers are given, the repository first.
  many(write, 'bulk/', 201);
  assert.deepEqual(changeSet(repo, 'base').foreign.map(f => f.dir), ['their-clone/', 'bulk/']);
  assert.equal(foreignLine(changeSet(repo, 'base')).split('\n').length, 2);
});

test('a path in .git/info/exclude is in no list; a name with a space and Arabic letters survives', () => {
  const { repo, git, write } = fixture();
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'scratch/\n*.secret\n');
  write('scratch/notes.txt'); write('keys.secret');
  write('عربي/ملف جديد.txt'); write('واجب منزلي.test.ts', 'test\n');
  const set = changeSet(repo, 'base');
  assert.deepEqual(set.untracked, ['عربي/ملف جديد.txt', 'واجب منزلي.test.ts']);
  assert.deepEqual(set.files, set.untracked);
  for (const list of [set.files, set.deleted, set.untracked, set.uncommitted]) assert.ok(!list.some(f => /scratch|secret/.test(f)));
  // Read without -z, as pre-review.mjs:76-77 reads them today, git quotes such a name and the file is "not there".
  const quoted = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
  assert.ok(quoted.every(name => name.startsWith('"') && !fs.existsSync(path.join(repo, name))), quoted.join(' | '));
  git('add', '-A'); git('commit', '-qm', 'feat: arabic names');
  assert.deepEqual(changeSet(repo, 'base', { at: 'HEAD' }).files, ['عربي/ملف جديد.txt', 'واجب منزلي.test.ts']);
});

test('a name with a line break or a quote, and two names that differ only in letter case, stay whole and apart', () => {
  const { repo, git } = fixture();
  // Windows cannot hold such files on disk, so they go into the index and a commit directly.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x\n', encoding: 'utf8', windowsHide: true }).trim();
  const odd = ['we"ird\nname.txt', 'Readme.md', 'README.md'];
  execFileSync('git', ['-c', 'core.protectNTFS=false', 'update-index', '-z', '--index-info'], { cwd: repo, input: odd.map(name => `100644 ${blob}\t${name}\0`).join(''), windowsHide: true });
  git('commit', '-qm', 'feat: odd names');
  const set = changeSet(repo, 'base', { at: 'HEAD' });
  assert.deepEqual(sorted(set.files), sorted(odd));
  assert.deepEqual(set.deleted, []);
  // They are not in the work folder: named as uncommitted, each under its own name.
  assert.deepEqual(sorted(set.uncommitted), sorted(odd));
  // One file on disk answers to both spellings on Windows; the list keeps both names of the index.
  fs.writeFileSync(path.join(repo, 'Readme.md'), 'x\n'); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  const live = changeSet(repo, 'base');
  assert.ok(live.files.includes('Readme.md') && live.files.includes('README.md'), JSON.stringify(live.files));
  assert.deepEqual(live.deleted, []);
});

test('an untracked name with a line break or a quote survives', { skip: process.platform === 'win32' && 'Windows file names cannot hold a line break or a quote; the test above covers the reader' }, () => {
  const { repo, write } = fixture();
  write('we"ird\nname.txt');
  assert.deepEqual(changeSet(repo, 'base').untracked, ['we"ird\nname.txt']);
});

test('a path deleted from the index that is on disk again is untracked, not deleted', () => {
  const { repo, git, write } = fixture({ 'tracked.txt': 'one\n', 'back.txt': 'one\n' });
  git('rm', '-q', '--cached', 'back.txt');
  const set = changeSet(repo, 'base');
  assert.deepEqual(set.files, ['back.txt']);
  assert.deepEqual([set.deleted, set.untracked], [[], ['back.txt']]);
  fs.rmSync(path.join(repo, 'back.txt'));
  assert.deepEqual(changeSet(repo, 'base').deleted, ['back.txt']);
  write('back.txt');
  assert.deepEqual(changeSet(repo, 'base').deleted, []);
});

test('a linked work tree has its own list; one inside the folder is foreign; the exclude file is the shared one', () => {
  const { repo, git, write } = fixture();
  write('main-only.txt');
  const wt = path.join(root, 'wt' + n);
  git('worktree', 'add', '-q', '-b', 'side', wt, 'base');
  fs.writeFileSync(path.join(wt, 'side-only.txt'), 'x\n');
  assert.deepEqual(changeSet(wt, 'base').files, ['side-only.txt']);
  assert.deepEqual(changeSet(repo, 'base').files, ['main-only.txt']);
  // A repository inside the linked work tree: the line names the exclude file git reads there (the main .git's).
  fs.mkdirSync(path.join(wt, 'clone'));
  execFileSync('git', ['init', '-q'], { cwd: path.join(wt, 'clone'), windowsHide: true });
  const inSide = changeSet(wt, 'base').foreign;
  assert.deepEqual(inSide.map(f => f.dir), ['clone/']);
  assert.equal(inSide[0].exclude.toLowerCase(), (fs.realpathSync.native(path.join(repo, '.git')).replace(/\\/g, '/') + '/info/exclude').toLowerCase());
  // Another session's work tree made inside this folder.
  git('worktree', 'add', '-q', '-b', 'inner', path.join(repo, 'their-tree'), 'base');
  assert.deepEqual(changeSet(repo, 'base').foreign.map(f => [f.dir, f.repo]), [['their-tree/', true]]);
});

test('a submodule with new work is one changed path, and is not foreign', () => {
  const lib = fixture({ 'lib.txt': 'one\n' });
  const { repo, git } = fixture();
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.repo.replace(/\\/g, '/'), 'sub');
  git('commit', '-qm', 'base with a submodule'); git('branch', '-f', 'base');
  assert.deepEqual(changeSet(repo, 'base').files, []);
  fs.writeFileSync(path.join(repo, 'sub', 'lib.txt'), 'two\n');
  execFileSync('git', ['commit', '-qam', 'lib two'], { cwd: path.join(repo, 'sub'), windowsHide: true });
  const set = changeSet(repo, 'base');
  assert.deepEqual([set.files, set.deleted, set.untracked, set.foreign], [['sub'], [], [], []]);
});

test('no merge base with the base is an error by name, never an empty list', () => {
  const { repo, git, write } = fixture();
  git('switch', '-q', '--orphan', 'alone');
  write('alone.txt'); git('add', '-A'); git('commit', '-qm', 'alone');
  assert.throws(() => changeSet(repo, 'base'), /^Error: no merge base with base$/);
  assert.throws(() => changeSet(repo, 'origin/none'), /no merge base with origin\/none/);
  assert.throws(() => changeSet(os.tmpdir(), 'base'), /no merge base with base/);
  assert.throws(() => changeSet(repo, ''), /the base must be a git ref/);
  assert.throws(() => changeSet(repo, '--all'), /the base must be a git ref/);
});

test('change-set.mjs imports no other gate script and reads no file itself', () => {
  const text = fs.readFileSync(path.join(scripts, 'change-set.mjs'), 'utf8');
  const imports = [...text.matchAll(/^\s*import\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['node:child_process']);
  assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/);
});
