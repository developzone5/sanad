// 2026-11-25 (owner, run 3): the size check said Small twice, the builder wrote Medium, and the full suite ran for nothing.
// The size step now runs the size check and saves its size (sanad.mjs size); the printed steps carry it, and the builder
// types none. To size up, the builder names the fact the size check missed, in one line the owner sees; sizing down needs
// the owner's words.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sanad.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-size-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
delete env.CLAUDE_CODE_SESSION_ID;
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
let n = 0;
function fixture() {
  const dir = path.join(root, 'case-' + (++n)), repo = path.join(dir, 'repo'), notes = path.join(dir, 'notes');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'base');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export function shown(x) { return x; }\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '-b', 'feat');
  const fx = { dir, repo, notes, state: path.join(dir, 'state') };
  run(fx, 'start', '--repo', repo, '--notes', notes, '--base', 'base', '--side', 'page', '--', 'node', '--test', 'a.test.mjs');
  for (const [f, t] of [['lines.md', 'T1 the list shows the due date\n'], ['places.md', 'P1 · a.js · lines 1 → C1\n'], ['siblings.md', 'S1 · b.js:3 the same rule → none: not the same rule\n'], ['check.md', '[T1] the due date is shown\n']]) fs.writeFileSync(path.join(notes, f), t);
  return fx;
}
function run(fx, ...args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: fx.repo, encoding: 'utf8', windowsHide: true, env: { ...env, SANAD_STATE_DIR: fx.state } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const size = (fx, ...args) => run(fx, 'size', '--repo', fx.repo, '--notes', fx.notes, '--files', 'a.js', '--names', 'shown', ...args);
const saved = (fx) => ({ txt: fs.readFileSync(path.join(fx.notes, 'size.txt'), 'utf8').trim(), json: JSON.parse(fs.readFileSync(path.join(fx.notes, 'size.json'), 'utf8')) });

test('the size step prints the command that runs the size check and saves its size; no size is typed', () => {
  const fx = fixture();
  const r = run(fx, 'next', '--repo', fx.repo, '--notes', fx.notes);
  assert.match(r.out, /^STEP size/m);
  assert.match(r.out, /\$ node \S*sanad\.mjs size --repo \S+ --notes \S+ --files PLANNED-FILES --names NAMES$/m);
  assert.doesNotMatch(r.out, /size-check\.mjs/);
  const s = size(fx);
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, /^SIZE: small \(plan\)/m, 'the size check\'s own lines are printed');
  assert.match(s.out, /^SIZE SAVED: small — the size check's own answer; the printed steps carry it$/m);
  assert.deepEqual([saved(fx).txt, saved(fx).json.tool, saved(fx).json.saved], ['small', 'small', 'small']);
  // The later steps carry the saved size: the next step is due, and its commands say small.
  const after = run(fx, 'next', '--repo', fx.repo, '--notes', fx.notes);
  assert.match(after.out, /^NEXT — size small /m);
  assert.doesNotMatch(after.out, /^STEP size/m);
  assert.doesNotMatch(after.out, /SIZE NOT FROM THE SIZE CHECK/);
});

test('to size up the builder names the fact the size check missed, in one line; without it nothing is saved', () => {
  const fx = fixture();
  let r = size(fx, '--up', 'medium');
  assert.equal(r.status, 2);
  assert.match(r.out, /--up needs --fact "<the fact the size check missed>"/);
  assert.ok(!fs.existsSync(path.join(fx.notes, 'size.txt')), 'nothing is saved');
  r = size(fx, '--up', 'small', '--fact', 'the list is read by the export too');
  assert.equal(r.status, 2);
  assert.match(r.out, /--up needs a size above the size check's small/);
  r = size(fx, '--up', 'medium', '--fact', 'the list is read by the export too');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^SIZE UP: small → medium — the fact the size check missed: the list is read by the export too$/m);
  assert.deepEqual([saved(fx).txt, saved(fx).json.tool, saved(fx).json.up], ['medium', 'small', { to: 'medium', fact: 'the list is read by the export too' }]);
});

test('sizing down needs the owner\'s words', () => {
  const fx = fixture();
  let r = size(fx, '--down', 'tiny');
  assert.equal(r.status, 2);
  assert.match(r.out, /sizing down needs the owner's words: --words/);
  r = size(fx, '--down', 'medium', '--words', 'make it smaller please');
  assert.equal(r.status, 2);
  assert.match(r.out, /--down needs a size below the size check's small/);
  r = size(fx, '--down', 'tiny', '--words', 'text only, I checked it');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^SIZE DOWN: small → tiny — the owner's words: "text only, I checked it"$/m);
  assert.equal(saved(fx).txt, 'tiny');
});

test('a size typed into size.txt by hand is said, with the way to save it', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.notes, 'size.txt'), 'medium\n');
  let r = run(fx, 'next', '--repo', fx.repo, '--notes', fx.notes);
  assert.match(r.out, /^SIZE NOT FROM THE SIZE CHECK: size\.txt says medium, and the size check saved none; save it with the size step/m);
  size(fx);
  fs.writeFileSync(path.join(fx.notes, 'size.txt'), 'medium\n');
  r = run(fx, 'next', '--repo', fx.repo, '--notes', fx.notes);
  assert.match(r.out, /^SIZE NOT FROM THE SIZE CHECK: size\.txt says medium, the size check saved small;/m);
});

// Review (2026-11-25): a size typed below the saved one set the lane, so a suite went to CI without the owner's words.
test('a size typed over the saved one does not set the lane lower', () => {
  const fx = fixture();
  assert.equal(size(fx, '--up', 'medium', '--fact', 'the list is read by the export too').status, 0);
  fs.writeFileSync(path.join(fx.notes, 'size.txt'), 'small\n');
  const r = run(fx, 'next', '--repo', fx.repo, '--notes', fx.notes);
  assert.match(r.out, /^NEXT — size medium /m);
  assert.match(r.out, /^SIZE NOT FROM THE SIZE CHECK: size\.txt says small, the size check saved medium;/m);
});
