import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 2026-11-19: `--part code` runs lint and types in the background right after the commit, and the full run comes
// while they still run. A second run that finds the same check running on the same code waits for it and reads its
// answer: it never starts a second lint or type check (two type checks would write one build-info file).
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pre-review.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-wait-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');

let n = 0;
// A repo with a web package whose fake eslint and tsc note each start, then take `slowMs` to pass.
function fixture(slowMs) {
  const dir = path.join(root, 'case' + (++n));
  const repo = path.join(dir, 'repo'), counts = path.join(dir, 'counts');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(counts);
  const env = { ...process.env, SANAD_STATE_DIR: path.join(dir, 'state'), GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false'); git('config', 'sanad.ticketRequired', 'false');
  // <name>: one x per start. <name>.order: S at each start and E at each end, so two at the same time read "SS".
  const slow = (name) => `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(path.join(counts, name))}, 'x'); fs.appendFileSync(${JSON.stringify(path.join(counts, name + '.order'))}, 'S');` +
    ` setTimeout(() => { fs.appendFileSync(${JSON.stringify(path.join(counts, name + '.order'))}, 'E'); process.exit(0); }, ${slowMs});\n`;
  write('web/package.json', '{"name":"web"}\n');
  write('web/tsconfig.app.json', '{}\n');
  write('web/.gitignore', 'node_modules/\n');
  write('web/node_modules/eslint/bin/eslint.js', slow('lint'));
  write('web/node_modules/typescript/bin/tsc', slow('types'));
  write('web/src/a.ts', 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  write('web/src/a.ts', 'export const a = 2;\n');
  git('commit', '-qam', 'fix(web): two');
  const runs = (name) => { try { return fs.readFileSync(path.join(counts, name), 'utf8').length; } catch { return 0; } };
  const order = (name) => { try { return fs.readFileSync(path.join(counts, name + '.order'), 'utf8'); } catch { return ''; } };
  // One pre-review, not waited for: { child, done } where done gives { status, stdout }.
  const start = (...extra) => {
    const child = spawn(process.execPath, [script, '--repo', repo, '--base', 'base', ...extra], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stdout += d; });
    return { child, done: new Promise(resolve => child.on('close', status => resolve({ status, stdout }))) };
  };
  return { repo, runs, order, start, write };
}
const until = async (what, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (what()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('two runs started together execute each slow check once: the second waits and reads the answer', async () => {
  const f = fixture(2500);
  const code = f.start('--part', 'code'), full = f.start();
  const [a, b] = await Promise.all([code.done, full.done]);
  assert.deepEqual([f.runs('lint'), f.runs('types')], [1, 1], 'one lint and one type check for the two runs\n' + a.stdout + b.stdout);
  const both = a.stdout + b.stdout;
  assert.equal((both.match(/✓ lint web \(1 file\) \(\d+\.\d s\)/g) || []).length, 1, 'one run ran it: ' + both);
  assert.equal((both.match(/✓ lint web \(1 file\) \(same code: passed at \d\d:\d\d\)/g) || []).length, 1, 'the other read its answer: ' + both);
  assert.equal((both.match(/✓ types web \(same code: passed at \d\d:\d\d\)/g) || []).length, 1);
  assert.equal(a.status, 0, a.stdout);
  assert.match(a.stdout.trimEnd().split(/\r?\n/).at(-1), /^PRE-REVIEW \(part: code\): 2 of 2 checks passed/);
});

test('must not change: a run on other code never waits for, or reads, the pass of the old code', async () => {
  // Slow enough that the second run's checks start while the first run's still run.
  const f = fixture(20000);
  const first = f.start('--part', 'code');
  assert.ok(await until(() => f.runs('lint') === 1 && f.runs('types') === 1), 'the first run started its checks');
  f.write('web/src/a.ts', 'export const a = 3;\n');
  const second = f.start('--part', 'code');
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.deepEqual([f.runs('lint'), f.runs('types')], [2, 2], 'the edited code is checked itself\n' + a.stdout + b.stdout);
  assert.doesNotMatch(b.stdout, /same code: passed/, b.stdout);
  // The two type checks write one build-info file: the second starts when the first has ended. Lint does not wait.
  assert.equal(f.order('types'), 'SESE', 'never two type checks of one project at the same time');
  assert.equal(f.order('lint'), 'SSEE', 'lint of other code starts at once');
});

test('killing the first run lets the second run the check itself', async () => {
  const f = fixture(3000);
  const first = f.start('--part', 'code');
  assert.ok(await until(() => f.runs('lint') === 1 && f.runs('types') === 1), 'the first run started its checks');
  const second = f.start('--part', 'code');
  // The second run sees the first one's markers and waits; then the first is stopped before it could keep a pass.
  await new Promise(r => setTimeout(r, 700));
  first.child.kill();
  await first.done;
  const b = await second.done;
  assert.equal(b.status, 0, b.stdout);
  assert.deepEqual([f.runs('lint'), f.runs('types')], [2, 2], 'the second run ran both itself\n' + b.stdout);
  assert.match(b.stdout, /✓ lint web \(1 file\) \(\d+\.\d s\)/, b.stdout);
  assert.match(b.stdout, /✓ types web \(\d+\.\d s\)/);
});
