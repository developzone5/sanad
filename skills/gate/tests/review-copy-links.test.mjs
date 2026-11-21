import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropCopy, dropCopies } from '../scripts/review-copy.mjs';

test('dropCopy does not change the mode of a file a link points to, and keeps the target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'x'); fs.chmodSync(outside, 0o444);
  const outDir = path.join(root, 'outdir'); fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'f.txt'), 'y');
  const copy = path.join(root, 'copy'); fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, 'own.txt'), 'z');
  let made = 0;
  try { fs.symlinkSync(outside, path.join(copy, 'link.txt')); made++; } catch { /* no right to make file links */ }
  try { fs.symlinkSync(outDir, path.join(copy, 'linkdir'), 'junction'); made++; } catch { /* none */ }
  if (!made) { t.skip('links not allowed here'); return; }
  const before = fs.statSync(outside).mode;
  dropCopy(copy);
  assert.ok(!fs.existsSync(copy), 'the copy is gone');
  assert.equal(fs.statSync(outside).mode, before, 'target mode unchanged');
  assert.equal(fs.readFileSync(path.join(outDir, 'f.txt'), 'utf8'), 'y', 'linked folder kept');
});

test('dropCopies on a linked task folder removes the link and keeps the target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tasklink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target'); fs.mkdirSync(path.join(target, '1'), { recursive: true });
  fs.writeFileSync(path.join(target, '1', 'keep.txt'), 'k');
  const copies = path.join(root, 'copies'); fs.mkdirSync(copies);
  try { fs.symlinkSync(target, path.join(copies, 'T1'), 'junction'); } catch { t.skip('links not allowed here'); return; }
  dropCopies('T1', copies);
  assert.ok(!fs.existsSync(path.join(copies, 'T1')), 'the link is gone');
  assert.equal(fs.readFileSync(path.join(target, '1', 'keep.txt'), 'utf8'), 'k', 'the target is kept');
});

// 2026-11-20 (Z4): making a round again never deletes through a linked task folder.
import { makeCopy } from '../scripts/review-copy.mjs';
import { execFileSync } from 'node:child_process';
test('makeCopy unlinks a linked task folder and keeps what the link points to', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-make-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  fs.mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', 'a.txt'); g('commit', '-qm', 'c');
  const commit = g('rev-parse', 'HEAD');
  const root = path.join(base, 'root'); fs.mkdirSync(root);
  const target = path.join(base, 'target'); fs.mkdirSync(path.join(target, '1'), { recursive: true });
  fs.writeFileSync(path.join(target, '1', 'keep.txt'), 'keep');
  try { fs.symlinkSync(target, path.join(root, 'T1'), 'junction'); } catch { t.skip('links not allowed here'); return; }
  makeCopy({ repo, commit, task: 'T1', round: 1, root });
  assert.equal(fs.readFileSync(path.join(target, '1', 'keep.txt'), 'utf8'), 'keep', 'the linked target is untouched');
  assert.ok(fs.existsSync(path.join(root, 'T1', '1', 'a.txt')), 'the copy is made in a real folder');
});
