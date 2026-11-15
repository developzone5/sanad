import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-15 (role-sync task): the startup line said "merge origin/staging into this branch before the ship
// brief" whenever the branch was behind. The merge brought one unrelated staging commit, made a new tree, and the
// full suite ran again for it. Behind is no reason to merge now; only a conflict is (the PR's own checks test the
// combined code). Real git repos, the real session-start.js in a child process.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-behind-')));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
const env = {
  ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const commit = (cwd, file, text, message) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '--', file); git(cwd, 'commit', '-q', '-m', message); };
const startLine = (cwd) => execFileSync(process.execPath, [path.join(hooks, 'session-start.js')], { input: JSON.stringify({ cwd }), env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  .split(/\r?\n/).find((l) => l.startsWith('vs origin/staging:')) || '';

// A remote with staging, a seed clone that pushes to it, and a feature branch one commit ahead.
let cases = 0;
function setup() {
  const dir = path.join(root, 'case' + (++cases));
  const remote = path.join(dir, 'remote.git'), seed = path.join(dir, 'seed'), work = path.join(dir, 'work');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '--initial-branch=staging', remote);
  git(dir, 'clone', '-q', remote, seed);
  git(seed, 'switch', '-q', '-c', 'staging');
  commit(seed, 'app.txt', 'one\n', 'first');
  git(seed, 'push', '-q', '-u', 'origin', 'staging');
  git(dir, 'clone', '-q', remote, work);
  git(work, 'switch', '-q', '-c', 'feat/x', 'origin/staging');
  commit(work, 'feature.txt', 'mine\n', 'feature');
  return { seed, work };
}

test('behind with no conflict: no merge is asked for; the PR checks test the combined code', () => {
  const { seed, work } = setup();
  assert.equal(startLine(work), 'vs origin/staging: ahead 1, behind 0');
  commit(seed, 'other.txt', 'theirs\n', 'unrelated staging work');
  git(seed, 'push', '-q');
  assert.equal(startLine(work), 'vs origin/staging: ahead 1, behind 1 — no conflict: no merge needed, the PR checks test the combined code');
  assert.equal(git(work, 'status', '--porcelain'), '', 'the check wrote nothing in the folder');
});

test('behind with a conflict: merge it before the ship brief', () => {
  const { seed, work } = setup();
  commit(seed, 'feature.txt', 'theirs\n', 'the same file, other text');
  git(seed, 'push', '-q');
  assert.equal(startLine(work), 'vs origin/staging: ahead 1, behind 1 — ⚠ conflicts with origin/staging: merge it into this branch before the ship brief');
  assert.equal(git(work, 'status', '--porcelain'), '');
});
