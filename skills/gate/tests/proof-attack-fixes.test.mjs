// The attack on the one-proof-per-round release (2026-11-23): one test per finding that a unit can hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { due, STEPS, render } from '../scripts/steps.mjs';
import { rememberBeforeProof, beforeProofPassed, notesInputs, BEFORE_PROOF_FILES, workTree } from '../scripts/pre-review-cache.mjs';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-attack-')));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function repo() {
  const top = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: top, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F'); git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(top, 'web'), { recursive: true });
  return { top, git, write: (f, t) => fs.writeFileSync(path.join(top, f), t) };
}

// Re-check 4, 2026-11-23 (owner: fix Blockers 4, 5 and 6).
test('Blocker 4: a pass of the checks before the proof is for its base; against another base it does not count', () => {
  const r = repo();
  r.write('web/a.ts', 'export const a = 1;\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'base');
  r.git('branch', 'main');
  r.write('web/b.ts', 'export const b = 1;\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'work');
  r.git('branch', 'other');
  const tree = workTree(r.top);
  rememberBeforeProof(r.top, tree, true, 'in', undefined, 'main');
  assert.equal(beforeProofPassed(r.top, tree, 'in', 'main'), true);
  assert.equal(beforeProofPassed(r.top, tree, 'in', 'other'), false, 'checks run against main are not the checks against other');
});

const pinned = (over) => {
  const pin = { round: 1, kind: 'full', commit: 'h2', ref: 'refs/sanad/review/t/1' };
  return { lane: 'small', size: 'small', testsOnly: false, last: false, round: 1, stop: 3, base: 'b', switches: {}, has: { lines: true, places: true, siblings: true, check: true, size: true, breaks: true },
    open: { places: 0, siblings: 0 }, git: { head: 'h2', headTree: 't', tree: 't', clean: true, changed: false, ahead: 1, untracked: 0, foreign: false }, pins: [pin], lastPin: pin, pinAtHead: true,
    proof: { done: false, early: false, breaks: 0, entries: 0, progress: [], logs: [] }, checks: { beforeProof: true }, suite: { done: false, receipt: null, ci: '', mark: 'full' },
    notes: { known: true, all: [], open: [] }, decisions: [], pushed: false, selfRead: 'h2', ...over };
};
const printed = (f) => render(due(f), { gate: '/g', repo: '/r', notes: '/n', base: 'b', engine: 'claude', size: 'small', lane: 'small', sides: [{ name: 'page', cwd: '', test: 'npx vitest run', fixFiles: ['a.ts'] }] }, f).join('\n');

test('Blocker 5: after a review whose notes cannot be read here, the proof is not offered', () => {
  assert.match(printed(pinned({})), /red-proof\.mjs/, 'notes read, none open: the proof is offered');
  const unread = printed(pinned({ notes: { known: false, all: [], open: [] } }));
  assert.doesNotMatch(unread, /red-proof\.mjs/);
  assert.match(unread, /the review's notes could not be read here/);
});

test('Blocker 6: uncommitted work holds the proof, after a review too', () => {
  const dirty = printed(pinned({ git: { head: 'h2', headTree: 't', tree: '', clean: false, changed: true, ahead: 1, untracked: 0, foreign: false } }));
  assert.doesNotMatch(dirty, /red-proof\.mjs/);
  assert.match(dirty, /there is uncommitted work: commit it/);
});

test('a break invalid on the test machine is saved only when its name is one break\'s alone', () => {
  const src = fs.readFileSync(new URL('../scripts/red-proof.mjs', import.meta.url), 'utf8');
  assert.match(src, /named\.filter\(\(x\) => String\(x\.name\) === String\(named\[0\]\.name\)\)\.length === 1/);
});

test('the proof is not offered at a pinned commit whose checks before the proof have not passed', () => {
  const pin = { round: 1, kind: 'full', commit: 'h2', ref: 'refs/sanad/review/t/1' };
  const f = { lane: 'small', size: 'small', testsOnly: false, last: false, round: 1, stop: 3, base: 'b', switches: {}, has: { lines: true, places: true, siblings: true, check: true, size: true, breaks: true },
    open: { places: 0, siblings: 0 }, git: { head: 'h2', headTree: 't', tree: 't', clean: true, changed: false, ahead: 1, untracked: 0, foreign: false }, pins: [pin], lastPin: pin, pinAtHead: true,
    proof: { done: false, early: false, breaks: 0, entries: 0, progress: [], logs: [] }, checks: { beforeProof: false }, suite: { done: false, receipt: null, ci: '', mark: 'full' },
    notes: { known: true, all: [], open: [] }, decisions: [], pushed: false, selfRead: 'h2' };
  const text = render(due(f), { gate: '/g', repo: '/r', notes: '/n', base: 'b', engine: 'claude', size: 'small', lane: 'small', sides: [{ name: 'page', cwd: '', test: 'npx vitest run', fixFiles: ['a.ts'] }] }, f).join('\n');
  assert.doesNotMatch(text, /red-proof\.mjs/);
  assert.ok(STEPS.some((s) => s.id === 'proof'));
});

test('the printed pre-review command names the notes folder, so its break plan check runs', () => {
  const step = STEPS.find((s) => s.id === 'checks-before-proof');
  // The prep lines come first (2026-11-25); the checks command is the line that runs pre-review.
  const line = step.lines({ gate: '/g', repo: '/r', notes: '/n', size: 'small' }, {}).find((l) => /pre-review\.mjs/.test(l.text)).text;
  assert.match(line, /pre-review\.mjs --before-proof .* --notes \/n$/);
});

test('a pass of the checks before the proof is for these list files too: a break list changed after it reopens the checks', () => {
  const r = repo();
  r.write('web/a.ts', 'export const a = 1;\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'base');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const files = BEFORE_PROOF_FILES.map((n) => path.join(notes, n));
  fs.writeFileSync(path.join(notes, 'breaks.json'), '[]');
  const tree = workTree(r.top);
  rememberBeforeProof(r.top, tree, true, notesInputs(files));
  assert.equal(beforeProofPassed(r.top, tree, notesInputs(files)), true);
  fs.writeFileSync(path.join(notes, 'breaks.json'), '[{"name":"b"}]');
  assert.equal(beforeProofPassed(r.top, tree, notesInputs(files)), false);
});
