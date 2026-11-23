// breaks.mjs add --put-from (2026-11-22, owner, PR 3 item 3): a reviewer's test for a bug the fix itself brought in
// passes on the base, so "red on the old code" cannot prove it. The break puts the REVIEWED commit's lines back,
// read from that commit, never typed; the commit must be a review pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyBreak } from '../scripts/red-proof.mjs';

const script = fileURLToPath(new URL('../scripts/breaks.mjs', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'breaks-put-from-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), list = path.join(root, 'breaks.json');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: path.join(root, 'state') };
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  // The reviewed commit: the fix brought in a bug (no guard for an empty list).
  fs.writeFileSync(path.join(repo, 'save.js'), 'export function save(list) {\n  return send(list);\n}\n');
  git('add', '-A'); git('commit', '-qm', 'reviewed');
  const reviewed = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/sanad/review/task/1', reviewed);
  // The fix of the reviewer's note.
  fs.writeFileSync(path.join(repo, 'save.js'), 'export function save(list) {\n  if (!list.length) return 0;\n  return send(list);\n}\n');
  git('add', '-A'); git('commit', '-qm', 'fixed');
  const add = (...args) => spawnSync(process.execPath, [script, 'add', '--repo', repo, '--breaks', list, '--file', 'save.js', ...args], { encoding: 'utf8', windowsHide: true, env });
  return { repo, list, git, reviewed, add };
}

test('--put-from puts the reviewed commit\'s lines back, read from that commit', (t) => {
  const f = fixture(t);
  const r = f.add('--line', '2', '--to', '3', '--put-from', `${f.reviewed.slice(0, 10)}:2`, '--must-fail', 'an empty list sends nothing');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [entry] = JSON.parse(fs.readFileSync(f.list, 'utf8'));
  assert.deepEqual([entry.find, entry.put, entry.mustFail], ['  if (!list.length) return 0;\n  return send(list);', '  return send(list);', ['an empty list sends nothing']]);
  // Applied, the break gives back the reviewed code exactly: the reviewer's test must fail on it.
  const now = fs.readFileSync(path.join(f.repo, 'save.js'), 'utf8');
  assert.equal(applyBreak(now, entry.find, entry.put), f.git('show', `${f.reviewed}:save.js`) + '\n');
});

test('--put-from refuses a commit that is no review pin, a bad range, a file the commit lacks, and a second put option', (t) => {
  const f = fixture(t);
  const head = f.git('rev-parse', 'HEAD');
  const notPinned = f.add('--line', '2', '--put-from', `${head}:2`, '--must-fail', 'x');
  assert.notEqual(notPinned.status, 0);
  assert.match(notPinned.stderr, /is not a reviewed commit \(no review pin under refs\/sanad\/review\/ holds it\)/);
  assert.match(f.add('--line', '2', '--put-from', 'nosuchcommit:2', '--must-fail', 'x').stderr, /is not a commit of this repository/);
  assert.match(f.add('--line', '2', '--put-from', `${f.reviewed}:9`, '--must-fail', 'x').stderr, /lines 9-9 are outside save\.js/);
  assert.match(f.add('--line', '2', '--put-from', `${f.reviewed}`, '--must-fail', 'x').stderr, /--put-from needs <reviewed commit>:<first line>/);
  assert.match(f.add('--line', '2', '--put-from', `${f.reviewed}:2`, '--put', 'y', '--must-fail', 'x').stderr, /Supply one of --put, --put-file or --put-from/);
  fs.writeFileSync(path.join(f.repo, 'new.js'), 'export const a = 1;\n');
  const missing = spawnSync(process.execPath, [script, 'add', '--repo', f.repo, '--breaks', f.list, '--file', 'new.js', '--line', '1', '--put-from', `${f.reviewed}:1`, '--must-fail', 'x'], { encoding: 'utf8', windowsHide: true });
  assert.match(missing.stderr, /new\.js is not a file in the reviewed commit/);
  // A path that is a folder in the reviewed commit and a file now: its listing is never taken as code (attack).
  f.git('checkout', '-q', f.reviewed);
  fs.mkdirSync(path.join(f.repo, 'lib'));
  fs.writeFileSync(path.join(f.repo, 'lib', 'x.js'), 'export const x = 1;\n');
  f.git('add', '-A'); f.git('commit', '-qm', 'a folder');
  const folderCommit = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/sanad/review/task/9', folderCommit);
  f.git('rm', '-rq', 'lib'); fs.writeFileSync(path.join(f.repo, 'lib'), 'export const lib = 1;\n'); f.git('add', '-A'); f.git('commit', '-qm', 'a file');
  const asFolder = spawnSync(process.execPath, [script, 'add', '--repo', f.repo, '--breaks', f.list, '--file', 'lib', '--line', '1', '--put-from', `${folderCommit}:1`, '--must-fail', 'x'], { encoding: 'utf8', windowsHide: true });
  assert.match(asFolder.stderr, /lib is not a file in the reviewed commit/);
  assert.equal(fs.existsSync(f.list), false, 'nothing was written');
});
