import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verdict, keep, keptWords } from '../scripts/one-job.mjs';
import { missingOneJob } from '../scripts/check-pr-body.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-job-'));
  roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  return dir;
}
const lines = (n, word) => Array.from({ length: n }, (_, i) => `export const ${word}${i} = ${i};`).join('\n') + '\n';
const run = (dir, ...args) => spawnSync(process.execPath, [path.join(scripts, 'one-job.mjs'), '--repo', dir, ...args], { encoding: 'utf8', windowsHide: true });

// User rule 2026-11-15: "small prs all the time and each prs one thing"; "some pr can not be 400 and its one job".
test('under about 400 logic lines and 30 files passes; over either asks the user; a keep passes with their words', () => {
  assert.equal(verdict({ lines: 400, codeFiles: 30 }, '').code, 0);
  const many = verdict({ lines: 401, codeFiles: 3 }, '');
  assert.equal(many.code, 1);
  assert.match(many.text, /Ask the user: "Split it, or keep it as one job\?"/);
  assert.match(many.text, /one-job\.mjs --keep "<the user's exact words>"/);
  assert.equal(verdict({ lines: 10, codeFiles: 31 }, '').code, 1);
  const kept = verdict({ lines: 900, codeFiles: 4 }, 'it is one job, the export');
  assert.equal(kept.code, 0);
  assert.match(kept.text, /kept as one job — the user: "it is one job, the export"/);
});

test('a keep is saved on the branch with the user\'s words; short words or no branch are refused', () => {
  const dir = repo();
  assert.throws(() => keep(dir, 'ok'), /own words/);
  assert.equal(keep(dir, 'keep it, one feature'), 'feat/x');
  assert.equal(keptWords(dir), 'keep it, one feature');
  assert.equal(git(dir, 'config', '--get', 'branch.feat/x.sanadOneJob'), 'keep it, one feature');
  git(dir, 'checkout', '-q', '--detach');
  assert.equal(keptWords(dir), '');
  assert.throws(() => keep(dir, 'keep it, one feature'), /not on a branch/);
});

test('the command counts logic code only: tests and texts do not count; over the line it fails until kept', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'big.test.ts'), lines(600, 't'));
  fs.writeFileSync(path.join(dir, 'src', 'en.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 600 }, (_, i) => ['k' + i, 'v']))));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'tests and texts');
  const quiet = run(dir, '--base', 'main');
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.match(quiet.stdout, /^ONE JOB: 0 logic lines in 0 code files/);

  fs.writeFileSync(path.join(dir, 'src', 'big.ts'), lines(420, 'c'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'code');
  const over = run(dir, '--base', 'main');
  assert.equal(over.status, 1, over.stdout + over.stderr);
  assert.match(over.stdout, /ONE JOB: 420 logic lines in 1 code files, over about 400/);

  const saved = run(dir, '--keep', 'one job: the whole export screen');
  assert.equal(saved.status, 0, saved.stderr);
  const after = run(dir, '--base', 'main');
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /kept as one job — the user: "one job: the whole export screen"/);

  const bad = run(dir, '--keep', 'x', '--base', 'main');
  assert.equal(bad.status, 2);
});

test('a kept branch needs a "One job:" line in the PR text', () => {
  assert.equal(missingOneJob('## Summary\nAdds the export.\n', 'keep it, one feature'), true);
  assert.equal(missingOneJob('## Summary\n- **One job:** the export screen and its endpoint are one feature.\n', 'keep it, one feature'), false);
  assert.equal(missingOneJob('One job: one rule on both sides.\n', 'keep it, one feature'), false);
  assert.equal(missingOneJob('## Summary\nAdds the export.\n', ''), false);
});
