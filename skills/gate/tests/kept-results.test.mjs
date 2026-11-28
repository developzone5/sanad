// 2026-11-28 (owner, batch b task 2): nothing runs twice on the same code. The places search and the size of a diff are
// kept for the exact code and the exact inputs; a kept result says so in one line; one changed byte, a new untracked file
// or another base runs both again. "ready" reads the kept size only when the session shows the run that printed its record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-results-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
let n = 0;
function fixture() {
  const repo = path.join(root, 'repo-' + (++n));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'base');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'src/rules.ts'), 'export function dueAfterPublish(due, publish) { return due > publish; }\n');
  fs.writeFileSync(path.join(repo, 'src/use.ts'), "import { dueAfterPublish } from './rules';\nexport const x = dueAfterPublish(1, 2);\n");
  git('add', 'src/rules.ts', 'src/use.ts');
  git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(repo, 'src/rules.ts'), 'export function dueAfterPublish(due, publish) { return due >= publish; }\n');
  git('commit', '-qam', 'fix');
  const state = path.join(root, 'state-' + n);
  return { repo, git, state, list: path.join(root, `places-${n}.md`) };
}
const env = (fx) => ({ ...process.env, SANAD_STATE_DIR: fx.state });
const places = (fx) => spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', fx.repo, '--names', 'dueAfterPublish', '--out', fx.list], { encoding: 'utf8', windowsHide: true, env: env(fx) });
const size = (fx, base = 'base') => spawnSync(process.execPath, [path.join(scripts, 'size-check.mjs'), '--repo', fx.repo, '--base', base], { encoding: 'utf8', windowsHide: true, env: env(fx) });
const KEPT_PLACES = /^places: kept — the same code and inputs, searched \S+; not searched again$/m;
const KEPT_SIZE = /^ {2}kept: the same change set was sized at \S+; not sized again$/m;

test('the places search runs once for the same code and names; the second run says it was kept', () => {
  const fx = fixture();
  const first = places(fx);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, KEPT_PLACES);
  const second = places(fx);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, KEPT_PLACES);
  assert.equal(fs.readFileSync(fx.list, 'utf8').split('\n').filter((l) => /^P\d/.test(l)).length, 2, 'the kept search gives the same places');
  // Another name is another input: it is searched; the kept name is read.
  const more = spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', fx.repo, '--names', 'dueAfterPublish,x', '--out', fx.list], { encoding: 'utf8', windowsHide: true, env: env(fx) });
  assert.match(more.stdout, /^places: 1 search\(es\) kept for the same code and inputs, 1 run now$/m, more.stdout + more.stderr);
});

test('the size of a diff is sized once per change set; the second run says it was kept', () => {
  const fx = fixture();
  const first = size(fx);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, KEPT_SIZE);
  const second = size(fx);
  assert.match(second.stdout, KEPT_SIZE);
  assert.equal(second.stdout.replace(KEPT_SIZE, '').trim(), first.stdout.trim(), 'the kept answer is the same answer');
  // A plan is never kept.
  const plan = spawnSync(process.execPath, [path.join(scripts, 'size-check.mjs'), '--repo', fx.repo, '--files', 'src/rules.ts'], { encoding: 'utf8', windowsHide: true, env: env(fx) });
  assert.doesNotMatch(plan.stdout, KEPT_SIZE);
});

test('one changed byte: the places search and the size both run again, and see the change', () => {
  const fx = fixture();
  places(fx); size(fx);
  assert.match(places(fx).stdout, KEPT_PLACES);
  assert.match(size(fx).stdout, KEPT_SIZE);
  // One byte in a tracked file, not committed.
  fs.writeFileSync(path.join(fx.repo, 'src/use.ts'), "import { dueAfterPublish } from './rules';\nexport const x = dueAfterPublish(1, 3);\n");
  const p = places(fx), s = size(fx);
  assert.doesNotMatch(p.stdout, KEPT_PLACES, p.stdout);
  assert.doesNotMatch(s.stdout, KEPT_SIZE, s.stdout);
  assert.match(s.stdout, /files: 2 /, 'the new size reads the changed file');
  // A new untracked file is new code too: it names the rule, so it is a new place.
  fs.writeFileSync(path.join(fx.repo, 'src/new.ts'), "export const y = dueAfterPublish(5, 6);\n");
  const p2 = places(fx), s2 = size(fx);
  assert.doesNotMatch(p2.stdout, KEPT_PLACES);
  assert.doesNotMatch(s2.stdout, KEPT_SIZE);
  assert.match(fs.readFileSync(fx.list, 'utf8'), /src\/new\.ts/);
  // Back to the code of a kept run: its kept answer is read again (the key is the code, not the time).
  fs.rmSync(path.join(fx.repo, 'src/new.ts'));
  assert.match(size(fx).stdout, KEPT_SIZE);
});

test('another base is another change set: the size runs again', () => {
  const fx = fixture();
  size(fx);
  fx.git('branch', 'other', 'feat');
  assert.doesNotMatch(size(fx, 'other').stdout, KEPT_SIZE);
});

// Review (batch b): a file that changed while the work ran must not be kept under the tree read before it.
test('a result is kept only when the working folder is still the tree its key was made for', async () => {
  const fx = fixture();
  process.env.SANAD_STATE_DIR = fx.state;
  const { keepIfSame, readKept, keyOf } = await import('../scripts/kept.mjs');
  const key = keyOf('size', 'a'.repeat(40), { x: 1 });
  assert.equal(keepIfSame('size', fx.repo, [[key, { size: 'small' }]], 'a'.repeat(40), () => 'b'.repeat(40)), false);
  assert.equal(readKept('size', fx.repo, key), null, 'a tree that moved during the work keeps nothing');
  assert.equal(keepIfSame('size', fx.repo, [[key, { size: 'small' }]], 'a'.repeat(40), () => 'a'.repeat(40)), true);
  assert.equal(readKept('size', fx.repo, key).value.size, 'small');
});

// Review (batch b): size-check.mjs reads which files are prose from the hooks (hooks/lib/code-paths.cjs), so a new hooks
// release can change the answer: the tools id covers that folder too.
test('a change in the hooks lib folder is a change of the tools: no kept answer is read', () => {
  const tmp = path.join(root, 'tools-' + (++n));
  fs.mkdirSync(path.join(tmp, 'skills', 'gate', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(scripts, 'kept.mjs'), path.join(tmp, 'skills', 'gate', 'scripts', 'kept.mjs'));
  const id = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import('${'file:///' + path.join(tmp, 'skills', 'gate', 'scripts', 'kept.mjs').replace(/\\/g, '/')}').then((m) => console.log(m.toolsId()))`], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  fs.writeFileSync(path.join(tmp, 'hooks', 'lib', 'code-paths.cjs'), 'module.exports = { isProsePath: () => false };\n');
  const before = id();
  fs.writeFileSync(path.join(tmp, 'hooks', 'lib', 'code-paths.cjs'), 'module.exports = { isProsePath: () => true };\n');
  const after = id();
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.notEqual(after, before);
});

// Review (batch b): the tests-only lane drops the proof from the required list, so it never comes from a kept answer.
test('the lane of next and ready is sized now: a kept "tests only" answer in the state folder is not read', async () => {
  const fx = fixture();
  process.env.SANAD_STATE_DIR = fx.state;
  fx.git('config', 'sanad.testsOnlyLane', 'true');
  const { keptSizeKey } = await import('../scripts/size-check.mjs');
  const { writeKept } = await import('../scripts/kept.mjs');
  writeKept('size', fx.repo, keptSizeKey(fx.repo, 'base').key, { size: 'tiny', testsOnly: true, roles: [], signals: {}, callers: [] });
  const { readFacts } = await import('../scripts/sanad.mjs');
  const notes = path.join(root, 'notes-' + (++n));
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'task.json'), JSON.stringify({ version: 1, repo: fx.repo, base: 'base' }));
  fs.writeFileSync(path.join(notes, 'size.txt'), 'small\n');
  const f = readFacts({ repo: fx.repo, notes });
  assert.equal(f.testsOnly, false, 'the product change in src/rules.ts is no tests-only change');
});
