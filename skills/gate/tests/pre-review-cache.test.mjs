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
});
