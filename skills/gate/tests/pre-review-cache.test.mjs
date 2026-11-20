import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 2026-11-16 (timed small test): "checks before review" took 13 of 25 working minutes. pre-review runs twice per
// fix round and each run repeated lint, types, size and the project check on code that had not changed. A check
// that passed on the exact same code, base and notes files is now read, not run.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pre-review.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-cache-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');

let n = 0;
// A repo with a web package (fake eslint and tsc that count their runs) and a project check that counts its runs.
function fixture({ mechanicalExit = 0 } = {}) {
  const dir = path.join(root, 'case' + (++n));
  const repo = path.join(dir, 'repo'), state = path.join(dir, 'state'), counts = path.join(dir, 'counts');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(counts);
  const env = { ...process.env, SANAD_STATE_DIR: state, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false'); git('config', 'sanad.ticketRequired', 'false');
  const counter = (name) => `require('fs').appendFileSync(${JSON.stringify(path.join(counts, name))}, 'x');`;
  write('web/package.json', '{"name":"web"}\n');
  write('web/tsconfig.app.json', '{}\n');
  write('web/.gitignore', 'node_modules/\n');
  write('web/node_modules/eslint/bin/eslint.js', counter('lint') + 'process.exit(0);\n');
  write('web/node_modules/typescript/bin/tsc', counter('types') + 'process.exit(0);\n');
  write('web/src/a.ts', 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  const mech = path.join(dir, 'mech.cjs');
  fs.writeFileSync(mech, counter('mechanical') + `console.log('MECHANICAL: 0 bugs'); process.exit(${mechanicalExit});\n`);
  git('config', 'sanad.mechanical', mech);
  write('web/src/a.ts', 'export const a = 2;\n');
  git('commit', '-qam', 'fix(web): two');
  const runs = (name) => { try { return fs.readFileSync(path.join(counts, name), 'utf8').length; } catch { return 0; } };
  const run = (...extra) => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base', ...extra], { encoding: 'utf8', env, windowsHide: true });
  return { repo, git, write, runs, run, dir };
}

test('a second run on the same code reads the passed checks instead of running them', () => {
  const f = fixture();
  const first = f.run();
  assert.match(first.stdout, /✓ lint web \(1 file\) \(\d+\.\d s\)/, first.stdout);
  assert.deepEqual([f.runs('lint'), f.runs('types'), f.runs('mechanical')], [1, 1, 1]);
  const second = f.run();
  assert.match(second.stdout, /✓ lint web \(1 file\) \(same code: passed at \d\d:\d\d\)/, second.stdout);
  assert.match(second.stdout, /✓ types web \(same code: passed at \d\d:\d\d\)/);
  assert.match(second.stdout, /✓ mechanical \(same code: passed at \d\d:\d\d\)\n\s+MECHANICAL: 0 bugs/, 'a kept answer still shows its lines');
  assert.deepEqual([f.runs('lint'), f.runs('types'), f.runs('mechanical')], [1, 1, 1], 'nothing ran again');
  // The checks that read state outside the code always run.
  assert.match(second.stdout, /✓ test asserts \(\d+\.\d s\)/);
  assert.match(second.stdout, /✓ one job \(\d+\.\d s\)/);
});

test('a changed file, even uncommitted or untracked, runs the checks again', () => {
  const f = fixture();
  f.run();
  f.write('web/src/a.ts', 'export const a = 3;\n');
  const edited = f.run();
  assert.match(edited.stdout, /✓ lint web \(1 file\) \(\d+\.\d s\)/, edited.stdout);
  assert.deepEqual([f.runs('lint'), f.runs('mechanical')], [2, 2]);
  f.write('web/src/new.ts', 'export const b = 1;\n');
  f.run();
  assert.equal(f.runs('mechanical'), 3, 'an untracked file is a change too');
  f.run();
  assert.equal(f.runs('mechanical'), 3, 'and the same state again is kept');
});

test('a failed check is never kept, and --no-cache runs every check', () => {
  const failing = fixture({ mechanicalExit: 1 });
  assert.equal(failing.run().status, 1);
  assert.equal(failing.run().status, 1);
  assert.equal(failing.runs('mechanical'), 2, 'a failure runs again every time');
  const f = fixture();
  f.run();
  const forced = f.run('--no-cache');
  assert.doesNotMatch(forced.stdout, /same code: passed/);
  assert.deepEqual([f.runs('lint'), f.runs('mechanical')], [2, 2]);
});

test('a changed notes file or tool means a new key: the check that reads it runs again', () => {
  const f = fixture();
  const lines = path.join(f.dir, 'lines.md'), check = path.join(f.dir, 'check.md');
  fs.writeFileSync(lines, '# Lines\n\nT1. the value is two\n');
  fs.writeFileSync(check, '- [T1] the value is two\n');
  f.run('--lines', lines, '--check', check);
  let r = f.run('--lines', lines, '--check', check);
  assert.match(r.stdout, /✓ check lines \(same code: passed at/, r.stdout);
  fs.writeFileSync(check, '- [T1] the value is two, shown once\n');
  r = f.run('--lines', lines, '--check', check);
  assert.match(r.stdout, /✓ check lines \(\d+\.\d s\)/, r.stdout);
  // The project check's own script changed: it runs again.
  fs.appendFileSync(path.join(f.dir, 'mech.cjs'), '// changed\n');
  f.run();
  // It reads no notes file, so the notes runs reused its answer: it ran first, then after its own script changed.
  assert.equal(f.runs('mechanical'), 2, 'runs: the first one, and after the script changed');
});

test('a new commit with the same files (a reworded message) runs the commit check again', () => {
  const f = fixture();
  f.run();
  f.git('commit', '-q', '--amend', '-m', 'fix(web): the value is two');
  const r = f.run();
  assert.match(r.stdout, /✓ commits \(\d+\.\d s\)/, r.stdout);
  // 2026-11-19: and only that one. The files are the same, so lint, types and the project check are read.
  assert.match(r.stdout, /✓ lint web \(1 file\) \(same code: passed at \d\d:\d\d\)/, r.stdout);
  assert.deepEqual([f.runs('lint'), f.runs('types'), f.runs('mechanical')], [1, 1, 1], 'a reworded message runs no lint or type check again');
});

// 2026-11-19: the commit (HEAD) was in every key, so committing a checked tree ran lint and types again on the
// very same files (about 30 s each on the test machine, twice per fix round).
test('check a dirty tree, commit it, check again: lint and types show the kept pass, and only the commits check runs', () => {
  const f = fixture();
  f.write('web/src/a.ts', 'export const a = 3;\n');
  const dirty = f.run();
  assert.match(dirty.stdout, /✓ lint web \(1 file\) \(\d+\.\d s\)/, dirty.stdout);
  assert.deepEqual([f.runs('lint'), f.runs('types'), f.runs('mechanical')], [1, 1, 1]);
  f.git('commit', '-qam', 'fix(web): three');
  const committed = f.run();
  assert.match(committed.stdout, /✓ lint web \(1 file\) \(same code: passed at \d\d:\d\d\)/, committed.stdout);
  assert.match(committed.stdout, /✓ types web \(same code: passed at \d\d:\d\d\)/);
  assert.match(committed.stdout, /✓ size \(same code: passed at \d\d:\d\d\)\n\s+SIZE: /, 'the kept size answer still shows its lines');
  assert.match(committed.stdout, /[✓✗] commits \(\d+\.\d s\)/, 'the commits check runs: its answer is about the commit');
  assert.deepEqual([f.runs('lint'), f.runs('types'), f.runs('mechanical')], [1, 1, 1], 'nothing ran again after the commit');
  // Must not change: the same commit with one more edit is other code.
  f.write('web/src/a.ts', 'export const a = 4;\n');
  f.run();
  assert.deepEqual([f.runs('lint'), f.runs('types')], [2, 2]);
});

test('a changed lock file or tool version misses the cache, though no tracked file changed', () => {
  const f = fixture();
  // The lock file and node_modules are not in git here, so the tree is the same before and after.
  f.write('web/.gitignore', 'node_modules/\npackage-lock.json\n');
  f.git('commit', '-qam', 'fix(web): ignore the lock file');
  f.write('web/package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/eslint":{"version":"9.0.0"}}}\n');
  f.write('web/node_modules/eslint/package.json', '{"name":"eslint","version":"9.0.0"}\n');
  f.run(); f.run();
  assert.deepEqual([f.runs('lint'), f.runs('types')], [1, 1], 'the same state twice: kept');
  f.write('web/node_modules/eslint/package.json', '{"name":"eslint","version":"9.1.0"}\n');
  const upgraded = f.run();
  assert.match(upgraded.stdout, /✓ lint web \(1 file\) \(\d+\.\d s\)/, 'another eslint version: lint runs again');
  assert.deepEqual([f.runs('lint'), f.runs('types')], [2, 1], 'the type check does not use eslint: it is kept');
  f.write('web/package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/eslint":{"version":"9.1.0"}}}\n');
  f.run();
  assert.deepEqual([f.runs('lint'), f.runs('types')], [3, 2], 'another lock file: every check of the package runs again');
  f.run();
  assert.deepEqual([f.runs('lint'), f.runs('types')], [3, 2]);
});

test('the key: the Node version is in every key; the commit is only in the key of the commits check', async () => {
  const { checkKey, NEVER } = await import('../scripts/pre-review-cache.mjs');
  const ident = { head: 'h1', tree: 't1', base: 'b1', mergeBase: 'm1', node: 'v20.20.2' };
  const lint = { name: 'lint web (1 file)', cmd: process.execPath, args: ['eslint.js', 'src/a.ts'], cwd: root };
  const commits = { name: 'commits', cmd: process.execPath, args: ['check-commits.mjs'], cwd: root };
  assert.equal(checkKey(lint, ident), checkKey(lint, { ...ident }), 'the same inputs: the same key');
  assert.notEqual(checkKey(lint, ident), checkKey(lint, { ...ident, node: 'v22.11.0' }), 'another Node version');
  assert.equal(checkKey(lint, ident), checkKey(lint, { ...ident, head: 'h2' }), 'another commit with the same tree: the same key');
  assert.notEqual(checkKey(commits, ident), checkKey(commits, { ...ident, head: 'h2' }), 'the commits check holds the commit');
  for (const part of ['tree', 'base', 'mergeBase']) assert.notEqual(checkKey(lint, ident), checkKey(lint, { ...ident, [part]: 'other' }), part + ' stays in every key');
  // Must not change: the checks that read state outside these inputs are never kept, and a failed check is not kept.
  assert.deepEqual([...NEVER].sort(), ['one job', 'places', 'siblings', 'test asserts']);
  for (const name of NEVER) assert.equal(checkKey({ ...lint, name }, ident), '');
  assert.equal(checkKey({ ...lint, notRun: 'no node_modules' }, ident), '');
});

test('a kept size answer that starts with a line break and is over 20,000 characters stays whole JSON', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'keep-'));
  const old = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = dir;
  try {
    const { remember, lookup } = await import('../scripts/pre-review-cache.mjs');
    const out = '\n' + JSON.stringify({ files: 'x'.repeat(30000) });
    remember([{ key: 'k-big-json', name: 'size', code: 0, out, ms: 1 }]);
    const got = lookup('k-big-json');
    assert.ok(got, 'the answer was kept');
    assert.equal(got.out, out, 'kept whole, not cut to the last 20,000 characters');
    assert.doesNotThrow(() => JSON.parse(got.out));
  } finally {
    if (old === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = old;
  }
});
