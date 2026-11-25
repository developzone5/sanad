// 2026-11-25 (owner, old proof entries): an old entry of the proof record blocked `sanad.mjs ready` after the code or the
// test command moved on, and a full proof ran again with no code change (run 3: one run; test 4: two). The ready check
// now lets an old entry go only when each test it named is proved by a newer passing entry on today's code, or is no
// longer in the tree, and a newer one ran every part of its command (proof-record.mjs oldEntries). The two cases the
// last attempt got wrong are here as the ready check reads them: a rerun of one test file does not release a proof that
// covered that file and a folder, and a failed proof is not cleared by another proof's pass.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEntry, codeFingerprint, testFileHashes } from '../scripts/proof-record.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sanad.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-old-entries-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
const gitEnv = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...gitEnv } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
let n = 0;
// A task branch with one product file and two test files (one in a folder), committed: the code id is today's.
function fixture() {
  const dir = path.join(root, 'case-' + (++n)), repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 't', 'more'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'base');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(repo, 't', 'a.test.js'), "it('[C1] shows the role', () => {});\nit('[C2] shows the name', () => {});\n");
  fs.writeFileSync(path.join(repo, 't', 'more', 'b.test.js'), "it('[C3] shows the date', () => {});\n");
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'change');
  const fx = { dir, repo, notes: path.join(dir, 'notes'), state: path.join(dir, 'state') };
  run(fx, 'start', '--repo', repo, '--notes', fx.notes, '--base', 'base', '--side', 'page', '--', 'node', '--test', 't/');
  return fx;
}
function run(fx, ...args) {
  const env = { ...process.env, ...gitEnv, SANAD_STATE_DIR: fx.state };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [script, ...args], { cwd: fx.repo, encoding: 'utf8', windowsHide: true, env });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const proofLine = (fx) => (/^READY (?:done    |NOT DONE) — proof: .*$/m.exec(run(fx, 'ready', '--repo', fx.repo, '--notes', fx.notes).out) || [''])[0];
const wait = () => { const until = Date.now() + 5; while (Date.now() < until) { /* entries are told apart by their time */ } };
// One passing proof of `command`, whose breaks caught `tests` (file → [[line, title]]), on `code` (today's by default).
function proof(fx, key, command, tests, { code } = {}) {
  process.env.SANAD_STATE_DIR = fx.state;
  const files = Object.keys(tests);
  const caught = Object.fromEntries(files.map((f) => [f, tests[f].map(([line, title]) => ({ line, title, ran: `${f} > ${title}` }))]));
  writeEntry(fx.repo, key, { ok: true, breaks: 1, command, cwd: '', code: code || codeFingerprint(fx.repo), targets: testFileHashes(fx.repo, ['a.js']),
    files: testFileHashes(fx.repo, files), caught, old: true, green: true });
  wait();
}
const A = 't/a.test.js', B = 't/more/b.test.js';
const OLD = 'b'.repeat(40);

test('ready: an old entry whose every test a newer passing entry on this tree proves no longer blocks (run 3, test 4)', () => {
  const fx = fixture();
  // Test 4's shape: a proof of one test file, then a wider proof on today's code that names its tests too.
  proof(fx, 'one', ['node', '--test', A], { [A]: [[1, '[C1] shows the role']] }, { code: OLD });
  assert.match(proofLine(fx), /NOT DONE — proof: the proof record is not for this tree/);
  proof(fx, 'wide', ['node', '--test', A, B], { [A]: [[1, '[C1] shows the role'], [2, '[C2] shows the name']], [B]: [[1, '[C3] shows the date']] });
  assert.match(proofLine(fx), /^READY done {5}— proof: 1 break\(s\) caught on this tree$/m);
});

test('ready, owner case 1: a rerun of one test file does not release a proof that covered that file and a folder', () => {
  const fx = fixture();
  // The older proof ran a test file and a folder; its breaks caught tests in the file only.
  proof(fx, 'folder', ['node', '--test', A, 't/more/'], { [A]: [[1, '[C1] shows the role']] }, { code: OLD });
  proof(fx, 'file', ['node', '--test', A], { [A]: [[1, '[C1] shows the role']] });
  assert.match(proofLine(fx), /^READY NOT DONE — proof: an older proof entry still blocks: `node --test t\/a\.test\.js t\/more\/` \(no newer passing entry on today's code ran every part of its command/m);
  // A proof that runs the file and the folder on today's code lets it go.
  proof(fx, 'both', ['node', '--test', A, 't/more/'], { [A]: [[1, '[C1] shows the role']] });
  assert.match(proofLine(fx), /^READY done {5}— proof:/m);
});

test('ready, owner case 2: a failed proof is not cleared by another proof that passed', () => {
  const fx = fixture();
  process.env.SANAD_STATE_DIR = fx.state;
  writeEntry(fx.repo, 'failed', { ok: false, reason: 'BREAK NOT CAUGHT [C3]', command: ['node', '--test', B], cwd: '' });
  wait();
  proof(fx, 'other', ['node', '--test', A, B], { [A]: [[1, '[C1] shows the role']], [B]: [[1, '[C3] shows the date']] });
  assert.match(proofLine(fx), /^READY NOT DONE — proof: an older proof entry still blocks: `node --test t\/more\/b\.test\.js` \(its last run did not end PROVED: only a passing run of its own command clears it\)/m);
  // Its own command passing replaces it.
  proof(fx, 'failed', ['node', '--test', B], { [B]: [[1, '[C3] shows the date']] });
  assert.match(proofLine(fx), /^READY done {5}— proof:/m);
});

// Review (2026-11-25): a renamed test file read as "no longer in the tree", and ready said done while its test still
// existed and nothing proved it on today's code.
test('ready: a renamed test file does not release the old entry that proved its tests', () => {
  const fx = fixture();
  proof(fx, 'old', ['node', '--test'], { [A]: [[1, '[C1] shows the role']] });
  git(fx.repo, 'mv', A, 't/renamed.test.js'); git(fx.repo, 'commit', '-qm', 'rename');
  proof(fx, 'other', ['node', '--test', B], { [B]: [[1, '[C3] shows the date']] });
  assert.match(proofLine(fx), /^READY NOT DONE — proof: an older proof entry still blocks: `node --test`/m);
});

// Review (2026-11-25): an ok entry with no code id (the format before 2026-11-17) proved nothing today and did not block.
test('ready: an ok entry with no code id still blocks', () => {
  const fx = fixture();
  process.env.SANAD_STATE_DIR = fx.state;
  writeEntry(fx.repo, 'before', { ok: true, breaks: 2, command: ['node', '--test', B], cwd: '', files: {} });
  wait();
  proof(fx, 'now', ['node', '--test', A, B], { [A]: [[1, '[C1] shows the role']], [B]: [[1, '[C3] shows the date']] });
  assert.match(proofLine(fx), /^READY NOT DONE — proof: an older proof entry still blocks: `node --test t\/more\/b\.test\.js` \(it names no test\)/m);
});
