// 2026-11-28 (review of the task 1 PR): a whole pre-review run keeps its record only for the places list its places check
// read. A places.md edited after that check, while slower checks ran, is a list no check read: no record is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-full-record-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
const { preReview } = await import('../scripts/pre-review.mjs');
const { readFullRun } = await import('../scripts/pre-review-cache.mjs');

let n = 0;
function fixture() {
  const dir = path.join(root, 'case-' + (++n));
  const repo = path.join(dir, 'repo'), notes = path.join(dir, 'notes');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'base');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  git('add', 'a.js'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  git('commit', '-qam', 'fix');
  for (const [f, t] of [['lines.md', 'T1. the due date is shown\n'], ['check.md', '[T1] the due date is shown\n'], ['places.md', 'Repo: x\nNames: a\nP1 · a · a.js · (file) · lines 1 → C1\n'], ['siblings.md', 'S1 · b.js:3 → none: not the same rule\n']]) fs.writeFileSync(path.join(notes, f), t);
  process.env.SANAD_STATE_DIR = path.join(dir, 'state');
  return { repo, notes };
}
// Every check passes at once; `slow` (a check name) waits, and `during` runs while it waits.
const fake = (slow, during) => (c) => new Promise((resolve) => {
  const done = () => resolve({ ...c, code: 0, out: '', ms: 1 });
  if (c.name === slow) setTimeout(() => { if (during) during(); done(); }, 150); else done();
});
const run = (fx, during) => preReview({ repo: fx.repo, base: 'base', node: process.execPath, remote: null, noCache: true, notes: fx.notes,
  lines: path.join(fx.notes, 'lines.md'), check: path.join(fx.notes, 'check.md'), places: path.join(fx.notes, 'places.md'), siblings: path.join(fx.notes, 'siblings.md'),
  run: fake('one job', during) });

test('a whole run keeps its record when the places list stays as its check left it', async () => {
  const fx = fixture();
  const r = await run(fx);
  assert.equal(r.ok, true, r.text);
  assert.ok(readFullRun(fx.repo), 'the record is kept');
  assert.match(r.text, /^SANAD-RECORD pre-review tree=[0-9a-f]{40} id=[0-9a-f]{64}$/m);
});

test('places.md edited after its check, while a slower check ran: no record is kept', async () => {
  const fx = fixture();
  const r = await run(fx, () => fs.appendFileSync(path.join(fx.notes, 'places.md'), 'P2 · a · b.js · (file) · lines 3 → none: closed by hand\n'));
  assert.equal(r.ok, true, r.text);
  assert.equal(readFullRun(fx.repo), null, 'no record for a list no check read');
  assert.doesNotMatch(r.text, /SANAD-RECORD/);
});
