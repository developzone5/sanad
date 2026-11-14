import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../scripts/is-main.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A link to the scripts folder: a junction on Windows (no admin right needed), a symbolic link elsewhere.
function linkedScripts() {
  const link = path.join(root, 'linked-scripts');
  if (!fs.existsSync(link)) fs.symlinkSync(fs.realpathSync.native(scripts), link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

// 2026-11-14: run through a link or a Windows short name (CI's RUNNER~1 temp folder), every gate script
// compared the typed path with its own real path, ran nothing and exited 0 with no output.
test('a gate script started through a linked folder still runs its command', () => {
  const words = path.join(root, 'words.txt');
  fs.writeFileSync(words, 'The notice names the wrong section.\n');
  const out = path.join(root, 'notes', 'lines.md');
  const r = spawnSync(process.execPath, [path.join(linkedScripts(), 'lines.mjs'), '--from', words, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^LINES: 1 line\(s\) T1\.\.T1 — /, 'the command ran (before the fix: no output at all)');
  assert.ok(fs.existsSync(out));
  const bad = spawnSync(process.execPath, [path.join(linkedScripts(), 'lines.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 2, 'a usage error through the link is still a usage error, not a silent exit 0');
});

test('isMain: the same file by its real path, through a link, or in another letter case on Windows; never another file', () => {
  const me = pathToFileURL(path.join(scripts, 'lines.mjs')).href;
  assert.equal(isMain(me, path.join(scripts, 'lines.mjs')), true);
  assert.equal(isMain(me, path.join(linkedScripts(), 'lines.mjs')), true);
  assert.equal(isMain(me, path.join(scripts, 'places.mjs')), false);
  assert.equal(isMain(me, undefined), false);
  if (process.platform === 'win32') assert.equal(isMain(me, path.join(scripts, 'LINES.MJS')), true);
});
