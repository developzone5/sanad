import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { subjectProblems } from '../scripts/check-commits.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-commits.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-commits-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// 2026-11-08 team rule: one task, one commit, a Conventional subject that ends with the ticket ID.
test('a clean subject passes; each broken rule is named', () => {
  assert.deepEqual(subjectProblems('fix(homework): clear filter on second click (TUW-225)'), []);
  assert.deepEqual(subjectProblems('feat: add the export (ABC-7)'), []);
  assert.match(subjectProblems('Fixed the filter (TUW-225)')[0], /not a Conventional Commit subject/);
  assert.match(subjectProblems('fix(homework): clear filter on second click')[0], /does not end with the ticket ID/);
  assert.match(subjectProblems('fix(homework): two things (TUW-225) (TUW-226)')[0], /names 2 tickets .*one task per PR/);
  assert.match(subjectProblems('fix(homework): ' + 'x'.repeat(60) + ' (TUW-225)')[0], /characters; at most 72/);
  assert.deepEqual(subjectProblems('chore: tidy the readme', { ticketRequired: false }), []);
});

test('the command: no commit yet passes, one clean commit passes, two commits or a bad subject fail', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  const commit = (file, subject) => { fs.writeFileSync(path.join(repo, file), file); git('add', '-A'); git('commit', '-qm', subject); };
  commit('base.txt', 'chore: base');
  git('switch', '-q', '-c', 'fix/x');
  const run = () => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main'], { encoding: 'utf8', windowsHide: true });
  let r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /COMMITS: no commit yet/);
  commit('a.txt', 'fix(homework): show the message once (TUW-228)');
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /COMMITS: one clean commit/);
  commit('b.txt', 'wip');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2 commits since main: squash them into one/);
  assert.match(r.stdout, /not a Conventional Commit subject.*wip/);
  git('config', 'sanad.ticketRequired', 'false');
  git('reset', '-q', '--soft', 'HEAD~2'); git('commit', '-qm', 'docs: no ticket here');
  assert.equal(run().status, 0, 'a repository without tickets can turn the ID part off');
});
