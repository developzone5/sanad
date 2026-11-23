import test from 'node:test';
import assert from 'node:assert/strict';
import cp, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { main, readFacts, evidenceBlock, openCount, proofStartedEarly } from '../scripts/sanad.mjs';
import { writeEntry, codeFingerprint } from '../scripts/proof-record.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sanad.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-next-'));
const emptyConfig = path.join(root, 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
const gitEnv = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
Object.assign(process.env, gitEnv);
const gitIn = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
let cases = 0;
// A repository whose path has a space, with a base branch and a task branch; notes and state outside it.
function fixture() {
  const dir = path.join(root, 'case-' + (++cases));
  const repo = path.join(dir, 'my repo');
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'base');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  gitIn(repo, 'add', 'a.js');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  gitIn(repo, 'checkout', '-q', '-b', 'feat');
  return { dir, repo, notes: path.join(dir, 'notes'), state: path.join(dir, 'state') };
}
function run(fx, ...args) {
  const env = { ...process.env, ...gitEnv, SANAD_STATE_DIR: fx.state };
  delete env.CLAUDE_CODE_SESSION_ID; // a Codex host has no session id
  const r = spawnSync(process.execPath, [script, ...args], { cwd: fx.cwd || fx.repo, encoding: 'utf8', windowsHide: true, env });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
// In this process, with the session's notes given by the test: the notes come from the session log, which a
// test folder does not have. fx.notesList is what the scanner would say: { known, all: [{ n, kind, state, text }] }.
async function runIn(fx, cmd, ...args) {
  process.env.SANAD_STATE_DIR = fx.state;
  const lines = [];
  const status = await main([cmd, '--repo', fx.repo, ...args], (l) => lines.push(l), { sessionNotes: () => fx.notesList });
  return { status, out: lines.join('\n') };
}
const start = (fx) => run(fx, 'start', '--repo', fx.repo, '--notes', fx.notes, '--base', 'base', '--suite', 'node run full-suite', '--side', 'page', '--fix-files', 'a.js', '--', 'node', '--test', 'a.test.mjs');
const note = (fx, name, text) => fs.writeFileSync(path.join(fx.notes, name), text);
// A whole `pre-review --before-proof` run that passed on the work tree as it is now (pre-review-cache.mjs).
async function beforeProofPassedHere(fx) {
  const cache = await import('../scripts/pre-review-cache.mjs');
  const keep = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = fx.state;
  // For the task's base, as sanad.mjs reads it (re-check 4: a pass is for one base).
  let base = '';
  try { base = JSON.parse(fs.readFileSync(path.join(fx.notes, 'task.json'), 'utf8')).base || ''; } catch { /* none */ }
  if (!base) { let i = ''; try { i = cp.execFileSync('git', ['-C', fx.repo, 'config', '--get', 'sanad.integration'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* unset */ } base = 'origin/' + (i || 'staging'); }
  try { cache.rememberBeforeProof(fx.repo, cache.workTree(fx.repo), true, cache.notesInputs(cache.BEFORE_PROOF_FILES.map((n) => path.join(fx.notes, n))), undefined, base); } finally { if (keep === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = keep; }
}
// The author's own read of its diff (the self-read step), recorded for the commit at HEAD.
const selfRead = (fx, found = 'none') => run(fx, 'self-read', '--repo', fx.repo, '--notes', fx.notes, '--found', found);
// A commit the author has read (the steps after the self-read step); `read: false` leaves the step due.
const commit = (fx, text, { read = true } = {}) => {
  fs.writeFileSync(path.join(fx.repo, 'a.js'), text); gitIn(fx.repo, 'add', 'a.js'); gitIn(fx.repo, 'commit', '-q', '-m', 'change');
  if (read && fs.existsSync(path.join(fx.notes, 'task.json'))) selfRead(fx);
  return gitIn(fx.repo, 'rev-parse', 'HEAD');
};
const stepsOf = (out) => [...out.matchAll(/^STEP (\S+)/gm)].map((m) => m[1]);
const proved = (fx, extra = {}) => { process.env.SANAD_STATE_DIR = fx.state; writeEntry(fx.repo, 'k1', { ok: true, breaks: 2, code: codeFingerprint(fx.repo), files: {}, targets: {}, caught: {}, ...extra }); };
const receipt = (fx, tree, name = 'check-1') => { fs.mkdirSync(path.join(fx.notes, 'evidence', name), { recursive: true }); fs.writeFileSync(path.join(fx.notes, 'evidence', name, 'metadata.json'), JSON.stringify({ runId: 'r1', status: 'passed', executable: 'node', args: ['run', 'full-suite'], source: { treeBefore: tree, treeAfter: tree } })); };
const pinFile = (fx, pins) => note(fx, 'review-pin.json', JSON.stringify({ version: 1, pins }));
// The lists of a task that reached the size line.
function upToSize(fx) {
  note(fx, 'lines.md', 'T1 the list shows the due date\n');
  note(fx, 'places.md', 'P1 · a.js · lines 1 → C1\n');
  note(fx, 'siblings.md', 'S1 · b.js:3 the same rule → none: not the same rule\n');
  note(fx, 'check.md', '[T1] the due date is shown\n');
  note(fx, 'size.txt', 'small\n');
}

test('each state of a small task prints its due step, with every path filled', async () => {
  const fx = fixture();
  const first = start(fx);
  assert.equal(first.status, 0, first.out);
  const n = fx.notes.replace(/\\/g, '/');
  assert.deepEqual(stepsOf(first.out), ['start']);
  assert.ok(first.out.includes(`--out ${n}/lines.md`), first.out);
  note(fx, 'lines.md', 'T1 the list shows the due date\n');
  let r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['places']);
  // The repository path has a space: it is one quoted word, and the notes path is whole.
  assert.ok(r.out.includes(`--repo '${fx.repo.replace(/\\/g, '/')}'`) || r.out.includes(`--repo '`), r.out);
  assert.ok(r.out.includes(`--out ${n}/places.md`), r.out);
  note(fx, 'places.md', 'P1 · a.js · lines 1 → \n');
  assert.deepEqual(stepsOf(run(fx, 'next').out), ['check-lines', 'second-look']);
  note(fx, 'siblings.md', 'S1 · b.js:3 the same rule → none: not the same rule\n');
  note(fx, 'check.md', '[T1] the due date is shown\n');
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['places-closed']);
  assert.match(r.out, /open: 1 place\(s\), 0 second-look line\(s\)/);

  // A list marked closed by hand in task.json is printed again: its own file says it is open.
  const task = JSON.parse(fs.readFileSync(path.join(fx.notes, 'task.json'), 'utf8'));
  fs.writeFileSync(path.join(fx.notes, 'task.json'), JSON.stringify({ ...task, done: { 'places-closed': true, proof: true, review: true }, closed: ['places'], placesClosed: true }));
  assert.deepEqual(stepsOf(run(fx, 'next').out), ['places-closed']);

  note(fx, 'places.md', 'P1 · a.js · lines 1 → C1\n');
  assert.deepEqual(stepsOf(run(fx, 'next').out), ['size']);
  note(fx, 'size.txt', 'small\n');
  assert.deepEqual(stepsOf(run(fx, 'next').out), ['tests-fix']);
  fs.writeFileSync(path.join(fx.repo, 'a.js'), 'export const a = 2;\n');
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['new-tests-once', 'commit']);
  assert.match(r.out, /\$ node --test a\.test\.mjs/);
  gitIn(fx.repo, 'commit', '-q', '-am', 'fix');
  // 2026-11-22 (owner, PR 3 item 1): the author reads its own diff before the checks, the proof and the review.
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['self-read']);
  assert.match(r.out, /\$ git -C \S+.* diff base\.\.\.HEAD/);
  assert.match(r.out, /"Every change" lines of \S*review-checklist\.md/);
  assert.match(r.out, /\$ node \S*sanad\.mjs self-read --repo .* --found FOUND/);
  // An uncommitted edit: nothing is recorded, and the step stays due.
  fs.writeFileSync(path.join(fx.repo, 'a.js'), 'export const a = 3;\n');
  const dirty = selfRead(fx);
  assert.equal(dirty.status, 1, dirty.out);
  assert.match(dirty.out, /SELF-READ: not recorded — commit the change first/);
  gitIn(fx.repo, 'checkout', '--', 'a.js');
  assert.equal(selfRead(fx, '').status, 2);
  const read = selfRead(fx, 'none');
  assert.equal(read.status, 0, read.out);
  assert.match(read.out, /^SELF-READ: recorded for commit [0-9a-f]{10} — none$/m);
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['checks-before-proof', 'breaks']);
  // A later commit makes the step due again: the record is for the commit read.
  gitIn(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'one more');
  assert.deepEqual(stepsOf(run(fx, 'next').out), ['self-read']);
  assert.equal(selfRead(fx, 'fixed the empty-list case; test a.test.mjs').status, 0);
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['checks-before-proof', 'breaks']);
  // 2026-11-23 (owner, one proof per round): every part, in the foreground; the proof waits for its pass on this code.
  assert.match(r.out, /^ {2}\$ node \S*pre-review\.mjs --before-proof --was small/m);
  assert.doesNotMatch(r.out, /--part code/);
  note(fx, 'breaks.json', JSON.stringify([{ name: 'b1', file: 'a.js', find: 'a = 2', put: 'a = 1', mustFail: ['x'] }]));
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['checks-before-proof'], 'the proof is not printed beside checks that have not passed');
  // The checks passed on this code (what a passing `pre-review --before-proof` keeps): the proof is due.
  await beforeProofPassedHere(fx);
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['proof']);
  assert.ok(r.out.includes(`--old base --files a.js --breaks ${n}/breaks.json --then-green --log ${n}/proof-page.log -- node --test a.test.mjs`), r.out);
  // No printed command keeps a path to fill in.
  for (const line of r.out.split(/\r?\n/).filter((l) => l.includes('$ '))) assert.doesNotMatch(line, /<[a-z ]+>/i, line);

  proved(fx);
  assert.deepEqual(stepsOf(run(fx, 'next').out), ['review']);
  const head = gitIn(fx.repo, 'rev-parse', 'HEAD');
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, ref: 'refs/sanad/review/t/1' }]);
  // The notes list cannot be read yet: the step is printed, with the next ones, and nothing is called done.
  assert.deepEqual(stepsOf(run(fx, 'next').out).slice(0, 2), ['notes', 'verdict']);
  fx.notesList = { known: true, all: [{ n: 1, kind: 'Bug', text: 'the date is a day off', state: 'open' }] };
  assert.deepEqual(stepsOf((await runIn(fx, 'next')).out), ['notes']);

  // A fix commit after the review: the fix round, with the last pin's ref.
  commit(fx, 'export const a = 3;\n');
  r = run(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['fix-round']);
  assert.match(r.out, /pre-review\.mjs --before-proof /);
  // 2026-11-23 (owner, one proof per round): the proof and the re-check wait for the checks to pass on the fix's code,
  // and for every note the builder can fix to be answered.
  assert.match(r.out, /the proof and the re-check wait: the checks before the proof have not passed on this code/);
  assert.doesNotMatch(r.out, /--changed-since/);
  await beforeProofPassedHere(fx);
  assert.match((await runIn(fx, 'next')).out, /the proof and the re-check wait: 1 note\(s\) still to fix and answer \(notes\.mjs answer\): NOTE 1/);
  fx.notesList = { known: true, all: [{ n: 1, kind: 'Bug', text: 'the date is a day off', state: 'fixed' }] };
  r = await runIn(fx, 'next');
  assert.match(r.out, /--changed-since refs\/sanad\/review\/t\/1 /);
  assert.match((await runIn(fx, 'next', '--last')).out, /the last round: the full proof/);

  // A clean re-check of that commit: the full proof (the record is for the older tree), the suite, the checks.
  const fixed = gitIn(fx.repo, 'rev-parse', 'HEAD');
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, ref: 'refs/sanad/review/t/1' }, { round: 2, kind: 'recheck', commit: fixed, ref: 'refs/sanad/review/t/2' }]);
  fx.notesList = { known: true, all: [{ n: 1, kind: 'Bug', text: 'the date is a day off', state: 'fixed' }] };
  r = await runIn(fx, 'next');
  assert.deepEqual(stepsOf(r.out), ['last-round']);
  assert.match(r.out, /red-proof\.mjs .*--then-green/);
  assert.doesNotMatch(r.out, /--changed-since/);
  assert.match(r.out, /the full suite, once/);
  // The suite passed on this tree: its line is not printed again.
  proved(fx);
  receipt(fx, gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}'));
  r = await runIn(fx, 'next');
  assert.doesNotMatch(r.out, /the full suite, once/);
  assert.deepEqual(stepsOf(r.out), ['verdict', 'ready']);
});

test('ready: a receipt for another tree, a partial proof and a pin at an older commit are not done', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const first = commit(fx, 'export const a = 2;\n');
  const treeA = gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}');
  proved(fx);
  receipt(fx, treeA);
  pinFile(fx, [{ round: 1, kind: 'full', commit: first, at: '2026-11-19T10:00:00.000Z' }]);
  note(fx, 'notes.json', JSON.stringify({ notes: [] }));
  fx.notesList = { known: true, all: [], reviews: [{ launchAt: '2026-11-19T10:01:00.000Z', doneAt: '2026-11-19T10:09:00.000Z' }] };
  let r = await runIn(fx, 'ready');
  assert.match(r.out, /READY done     — review:/);
  assert.match(r.out, /READY done     — proof: 2 break\(s\) caught on this tree/);
  assert.match(r.out, /READY done     — suite: passed on this tree/);
  assert.match(r.out, /READY NOT DONE — PR text: no pr-body\.md/);
  assert.equal(r.status, 1);

  // One byte changes after the suite: nothing above is done for the new tree.
  commit(fx, 'export const a = 3;\n');
  r = await runIn(fx, 'ready');
  assert.match(r.out, /READY NOT DONE — suite: no passing full-suite receipt for this tree/);
  assert.match(r.out, /READY NOT DONE — review: the last review read /);
  assert.match(r.out, /READY NOT DONE — proof: the proof record is not for this tree/);
  assert.match(r.out, /READY NOT DONE — one commit: 2 commit\(s\)/);

  // A partial run (--changed-since) sets no ok: it is no proof, even beside a proved entry of this tree.
  proved(fx);
  assert.match(run(fx, 'ready').out, /READY done     — proof:/);
  process.env.SANAD_STATE_DIR = fx.state;
  writeEntry(fx.repo, 'k2', { partial: true, perBreak: {} });
  assert.match(run(fx, 'ready').out, /READY NOT DONE — proof:/);
  // An uncommitted edit: no receipt can be for this tree.
  fs.writeFileSync(path.join(fx.repo, 'a.js'), 'export const a = 4;\n');
  assert.match(run(fx, 'ready').out, /READY NOT DONE — suite: uncommitted or untracked work/);
});

test('a push-now decision with the owner words moves the open items to owed; the author words do not', () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  commit(fx, 'export const a = 2;\n');
  assert.match(run(fx, 'owed').out, /OWED: none \(no push-now decision\)/);
  note(fx, 'decisions.json', JSON.stringify({ version: 1, decisions: [{ id: 'D1', kind: 'push-now', words: 'I will push, the proof can finish later', source: 'author' }] }));
  assert.match(run(fx, 'owed').out, /OWED: none \(no push-now decision\)/);
  note(fx, 'decisions.json', JSON.stringify({ version: 1, decisions: [{ id: 'D1', kind: 'push-now', words: 'push it now', source: 'user' }] }));
  const r = run(fx, 'owed');
  assert.equal(r.status, 1);
  assert.match(r.out, /OWED — proof: no proof record/);
  assert.match(r.out, /OWED — suite: /);
  assert.match(r.out, /A green CI run clears none of them/);
  // The proof done on this tree leaves the list; the rest stays owed.
  proved(fx);
  assert.doesNotMatch(run(fx, 'owed').out, /OWED — proof/);
  assert.match(run(fx, 'status').out, /owed: .*suite/);
});

test('status prints real numbers: the proof progress file, the rounds and the open notes by group', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  note(fx, 'proof-page.log.progress.json', JSON.stringify({ done: 7, total: 48, minutesLeft: 28 }));
  pinFile(fx, [{ round: 1, kind: 'full', commit: head }]);
  fx.notesList = { known: true, all: [{ n: 1, kind: 'Bug', state: 'open' }, { n: 2, kind: 'Bug', state: 'open' }, { n: 3, kind: 'Gap', state: 'open' }, { n: 4, kind: 'Gap', state: 'fixed' }] };
  // With no session log the notes are not read, and nothing is called answered.
  assert.match(run(fx, 'status').out, /open notes: not read/);
  const out = (await runIn(fx, 'status')).out;
  assert.match(out, /proof: 7 of 48, about 28 min left/);
  assert.match(out, /rounds: 1 of 3 before the stop rule/);
  assert.match(out, /open notes: Bug 2, Gap 1/);
  gitIn(fx.repo, 'config', 'sanad.stopRound', '2');
  assert.match((await runIn(fx, 'status')).out, /rounds: 1 of 2 before the stop rule/);
});

test('two work trees of one repository hold two tasks, and next in one never reads the other', () => {
  const a = fixture();
  const b = { ...a, repo: path.join(a.dir, 'second tree'), notes: path.join(a.dir, 'notes-b') };
  gitIn(a.repo, 'worktree', 'add', '-q', '-b', 'feat-b', b.repo, 'base');
  assert.equal(start(a).status, 0);
  assert.equal(start(b).status, 0);
  note(a, 'lines.md', 'T1 one\n');
  const na = run(a, 'next').out, nb = run(b, 'next').out;
  assert.deepEqual(stepsOf(na), ['places']);
  assert.deepEqual(stepsOf(nb), ['start']);
  assert.ok(!na.includes('notes-b') && nb.includes('notes-b'), na + nb);
  // A folder with no task says so and exits 0: nothing here stops the author.
  const none = fixture();
  const r = run(none, 'next');
  assert.equal(r.status, 0);
  assert.match(r.out, /NEXT: no task here/);
});

test('a deleted or broken task.json stops nothing: next still answers from the other records', () => {
  const fx = fixture();
  start(fx);
  note(fx, 'lines.md', 'T1 one\n');
  fs.writeFileSync(path.join(fx.notes, 'task.json'), '{ broken');
  let r = run(fx, 'next');
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(stepsOf(r.out), ['places']);
  fs.rmSync(path.join(fx.notes, 'task.json'));
  note(fx, 'review-pin.json', 'not json');
  r = run(fx, 'next');
  assert.equal(r.status, 0, r.out);
  assert.equal(run(fx, 'ready').status, 1);
  assert.equal(run(fx, 'status').status, 0);
});

test('sanad.mjs starts no process but git, at every step', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  proved(fx);
  const seen = [];
  const names = ['execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork'];
  const real = Object.fromEntries(names.map((k) => [k, cp[k]]));
  for (const k of names) cp[k] = (file, ...rest) => { seen.push(k === 'exec' || k === 'execSync' ? String(file).split(' ')[0] : String(file)); return real[k](file, ...rest); };
  syncBuiltinESMExports();
  const lines = [];
  try {
    process.env.SANAD_STATE_DIR = fx.state;
    for (const cmd of ['next', 'status', 'ready', 'owed', 'pr-body']) await main([cmd, '--repo', fx.repo, '--notes', fx.notes], (l) => lines.push(l));
    pinFile(fx, [{ round: 1, kind: 'full', commit: head }]);
    await main(['next', '--repo', fx.repo], (l) => lines.push(l));
    await main(['start', '--repo', fx.repo, '--notes', fx.notes], (l) => lines.push(l));
  } finally {
    for (const k of names) cp[k] = real[k];
    syncBuiltinESMExports();
  }
  assert.ok(seen.length > 5, 'git was asked');
  assert.deepEqual([...new Set(seen)], ['git']);
  assert.ok(lines.some((l) => l.startsWith('STEP ')) && lines.some((l) => l.startsWith('READY')));
});

test('next answers in under 1 second on a repository with 1,500 untracked files, and reads no proof for it', async (t) => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  commit(fx, 'export const a = 2;\n');
  proved(fx);
  const other = path.join(fx.repo, 'other session');
  fs.mkdirSync(other);
  for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(other, `f${i}.txt`), 'x' + i);
  const r = run(fx, 'next');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FOREIGN\? other session\/ holds 1500 untracked files: add it to \.git\/info\/exclude/);
  // The tool's own work, measured in this process: the start of Node is the host's, not the tool's. The first
  // call warms the disk cache; the second is the measured one. It reads no file of the repository.
  process.env.SANAD_STATE_DIR = fx.state;
  await main(['next', '--repo', fx.repo], () => {});
  const lines = [];
  const t0 = process.hrtime.bigint();
  await main(['next', '--repo', fx.repo], (l) => lines.push(l));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.diagnostic(`next took ${Math.round(ms)} ms in process`);
  assert.ok(ms < 1000, `next took ${Math.round(ms)} ms`);
  assert.ok(lines.some((l) => l.startsWith('FOREIGN? ')));
  assert.equal(readFacts({ repo: fx.repo, notes: fx.notes }).proof.done, false);
});

test('pr-body prints the evidence between two lines that name the tree; open list lines are counted from the file', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  const tree = gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}');
  proved(fx);
  receipt(fx, tree);
  pinFile(fx, [{ round: 1, kind: 'full', commit: head }]);
  fx.notesList = { known: true, all: [{ n: 1, kind: 'Bug', state: 'fixed' }, { n: 2, kind: 'Gap', state: 'user' }] };
  note(fx, 'decisions.json', JSON.stringify({ version: 1, decisions: [{ id: 'D1', kind: 'note', question: 'a rare case on a slow network', words: 'leave it for now', source: 'user' }] }));
  const out = (await runIn(fx, 'pr-body')).out.split(/\r?\n/).filter(Boolean);
  assert.equal(out[0], `<!-- sanad-evidence tree=${tree} -->`);
  assert.ok(out.includes('- Breaks caught: 2, on this tree'));
  assert.ok(out.includes('- Suite: passed on this tree'));
  assert.ok(out.includes('- Review rounds: 1 (full)'));
  assert.ok(out.includes('- Notes: 1 fixed, 1 decided by the user, 0 refuted, 0 open'));
  assert.ok(out.includes('- Decided by the user: a rare case on a slow network — the user said "leave it for now"'), out.join('\n'));
  assert.ok(out.includes('<!-- /sanad-evidence -->'));
  process.env.SANAD_STATE_DIR = fx.state;
  assert.deepEqual(evidenceBlock(readFacts({ repo: fx.repo, notes: fx.notes, deep: true, sessionNotes: () => fx.notesList })), out.slice(0, out.indexOf('<!-- /sanad-evidence -->') + 1));
  // With no session log the block says the notes were not read; it never prints a count it did not read.
  assert.match(run(fx, 'pr-body').out, /- Notes: not read/);
  assert.equal(openCount('P1 · a → C1\nP2 · b → \n- P3 · c →\nnot a place → \n', 'P'), 2);
});

test('P20: next, ready and the PR block show an owner switch with its origin, and the lane', async () => {
  const fx = fixture();
  start(fx);
  gitIn(fx.repo, 'config', 'sanad.stopRound', '1');
  gitIn(fx.repo, 'config', 'sanad.designChoice', 'true');
  const next = run(fx, 'next').out;
  assert.match(next, /Owner switch invalid: sanad\.stopRound = 1 \(local; origin: [^)]*config/);
  assert.match(next, /Owner switch on: sanad\.designChoice = true \(local;/);
  assert.match(run(fx, 'ready').out, /READY lane: normal/);
  assert.match((await runIn(fx, 'pr-body')).out, /- Lane: normal/);
});

test('ready: the PR text that pr-body prints is accepted; a changed evidence line is refused', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  proved(fx);
  receipt(fx, gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}'));
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, at: '2026-11-19T10:00:00.000Z' }]);
  fx.notesList = { known: true, all: [], reviews: [{ launchAt: '2026-11-19T10:01:00.000Z', doneAt: '2026-11-19T10:09:00.000Z' }] };
  const block = (await runIn(fx, 'pr-body')).out;
  note(fx, 'pr-body.md', `Summary\n\n${block}\n`);
  let r = await runIn(fx, 'ready');
  assert.match(r.out, /READY done     — PR text: clean/, r.out);
  assert.equal(r.status, 0, r.out);
  note(fx, 'pr-body.md', `Summary\n\n${block.replace('- Suite: passed on this tree', '- Suite: passed (typed by hand)')}\n`);
  r = await runIn(fx, 'ready');
  assert.match(r.out, /READY NOT DONE — PR text: evidence line differs/, r.out);
});

test('ready: a pin with no completed reviewer run after it is not a review', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, at: '2026-11-19T10:00:00.000Z' }]);
  for (const reviews of [null, [], [{ launchAt: '2026-11-19T09:00:00.000Z', doneAt: '2026-11-19T09:05:00.000Z' }]]) {
    fx.notesList = { known: true, all: [], reviews };
    assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: round 1 is pinned to HEAD, but no completed reviewer run/);
  }
  fx.notesList = { known: true, all: [], reviews: [{ launchAt: '2026-11-19T10:01:00.000Z', doneAt: '2026-11-19T10:09:00.000Z' }] };
  assert.match((await runIn(fx, 'ready')).out, /READY done     — review: round 1 is pinned to HEAD and a reviewer has reported/);
});

test('ready: a task with two sides needs a proof of each side', async () => {
  const fx = fixture();
  start(fx);
  run(fx, 'start', '--repo', fx.repo, '--notes', fx.notes, '--side', 'server', '--', 'dotnet', 'test');
  upToSize(fx);
  commit(fx, 'export const a = 2;\n');
  const { recordKey } = await import('../scripts/proof-record.mjs');
  proved(fx, { command: ['node', '--test', 'a.test.mjs'], cwd: '' });
  const out = (await runIn(fx, 'ready')).out;
  assert.match(out, /READY NOT DONE — proof: no proof of the side\(s\): server/, out);
  process.env.SANAD_STATE_DIR = fx.state;
  writeEntry(fx.repo, recordKey(['dotnet', 'test'], ''), { ok: true, breaks: 1, code: codeFingerprint(fx.repo), files: {}, targets: {}, caught: {}, command: ['dotnet', 'test'], cwd: '' });
  assert.match((await runIn(fx, 'ready')).out, /READY done     — proof:/);
});

test('ready: a filtered test command is not the full suite', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  commit(fx, 'export const a = 2;\n');
  const tree = gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}');
  const filtered = (args) => { fs.mkdirSync(path.join(fx.notes, 'evidence', 'check-f'), { recursive: true }); fs.writeFileSync(path.join(fx.notes, 'evidence', 'check-f', 'metadata.json'), JSON.stringify({ status: 'passed', executable: 'node', args, source: { treeBefore: tree, treeAfter: tree } })); };
  filtered(['run', 'full-suite', '--', '--grep', 'one test']);
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — suite: no passing full-suite receipt/);
  filtered(['run', 'full-suite']);
  assert.match((await runIn(fx, 'ready')).out, /READY done     — suite: passed on this tree/);
});

test('pr-body shows the full text of a finding a decision covers', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  pinFile(fx, [{ round: 1, kind: 'full', commit: head }]);
  fx.notesList = { known: true, all: [{ n: 4, kind: 'Gap', state: 'user', text: 'a slow network drops the second save of the same row' }] };
  note(fx, 'decisions.json', JSON.stringify({ version: 1, decisions: [{ id: 'D1', kind: 'note', question: 'slow network', words: 'leave it for now', source: 'user', notes: ['N4'] }] }));
  const out = (await runIn(fx, 'pr-body')).out;
  assert.match(out, /slow network — the user said "leave it for now" \[N4: a slow network drops the second save of the same row\]/, out);
});

test('ready: a round of several seats counts each run by its launch id and the other engine by its report file', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  const pinAt = '2026-11-19T10:00:00.000Z';
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, at: pinAt, seats: ['risk files', 'whole diff', 'other engine'] }]);
  // Reviewers launched together share one launch time: the id tells them apart.
  const rep = (id) => ({ id, launchAt: '2026-11-19T10:01:00.000Z', doneAt: '2026-11-19T10:09:00.000Z' });
  fx.notesList = { known: true, all: [], reviews: [rep('a')] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 1 of 3 reviewer seats/);
  fx.notesList = { known: true, all: [], reviews: [rep('a'), rep('a'), rep('a')] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 1 of 3/);
  fx.notesList = { known: true, all: [], reviews: [rep('a'), rep('b')] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 2 of 3/);
  // The other engine's seat is its report file, newer than the pin; a file from before the pin does not count.
  const file = path.join(fx.notes, 'codex-review.md');
  fs.writeFileSync(file, 'PASS\n');
  fs.utimesSync(file, new Date('2026-11-19T09:00:00.000Z'), new Date('2026-11-19T09:00:00.000Z'));
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 2 of 3/);
  fs.utimesSync(file, new Date('2026-11-19T10:05:00.000Z'), new Date('2026-11-19T10:05:00.000Z'));
  const out = (await runIn(fx, 'ready')).out;
  assert.match(out, /READY done     — review:/);
  assert.doesNotMatch(out, /could not be matched/);
  // A run launched before the pin never counts.
  fx.notesList = { known: true, all: [], reviews: [{ id: 'z', launchAt: '2026-11-19T09:00:00.000Z', doneAt: '2026-11-19T09:05:00.000Z' }, rep('a')] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 2 of 3/);
});

test('ready: runs with no id and no seat cannot be matched; one finished run after the pin is the round, and ready says so', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, at: '2026-11-19T10:00:00.000Z', seats: ['risk', 'whole', 'other'] }]);
  fx.notesList = { known: true, all: [], reviews: [{ launchAt: '2026-11-19T09:00:00.000Z', doneAt: '2026-11-19T09:05:00.000Z' }] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*no completed reviewer run/);
  fx.notesList = { known: true, all: [], reviews: [{ launchAt: '2026-11-19T10:01:00.000Z', doneAt: '2026-11-19T10:09:00.000Z' }] };
  const out = (await runIn(fx, 'ready')).out;
  assert.match(out, /READY done     — review:/);
  assert.match(out, /READY note — review: the 3 seats of round 1 could not be matched/);
  // Runs that name their seat are still counted by seat.
  fx.notesList = { known: true, all: [], reviews: [{ seat: 'risk', launchAt: '2026-11-19T10:01:00.000Z', doneAt: '2026-11-19T10:09:00.000Z' }] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 1 of 3/);
});

test('ready: a suite command with a space inside one argument is compared as a list', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  commit(fx, 'export const a = 2;\n');
  const tree = gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}');
  const file = path.join(fx.notes, 'task.json');
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  task.suite = "node run 'spec files/all.mjs'";
  fs.writeFileSync(file, JSON.stringify(task));
  const make = (args) => { fs.mkdirSync(path.join(fx.notes, 'evidence', 'check-s'), { recursive: true }); fs.writeFileSync(path.join(fx.notes, 'evidence', 'check-s', 'metadata.json'), JSON.stringify({ status: 'passed', executable: 'node', args, source: { treeBefore: tree, treeAfter: tree } })); };
  make(['run', 'spec', 'files/all.mjs']);
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — suite: no passing full-suite receipt/);
  make(['run', 'spec files/all.mjs']);
  assert.match((await runIn(fx, 'ready')).out, /READY done     — suite: passed on this tree/);
});

test('ready: a suite argument with an apostrophe, written the way q() writes it, is accepted', async () => {
  const { q } = await import('../scripts/steps.mjs');
  const { markWords, sameCommand } = await import('../scripts/sanad.mjs');
  const arg = "spec files/user's test.mjs";
  const line = ['node', 'run', arg].map(q).join(' ');
  assert.match(line, /user'\\''s test\.mjs'/);
  assert.deepEqual(markWords(line), ['node', 'run', arg]);
  assert.equal(sameCommand(['node', 'run', arg], line), true);
  assert.equal(sameCommand(['node', 'run', 'spec', 'files/user', 's test.mjs'], line), false);
});

// A commit the author has read, as commit() above.
const addFile = (fx, name, text) => { fs.writeFileSync(path.join(fx.repo, name), text); gitIn(fx.repo, 'add', name); gitIn(fx.repo, 'commit', '-q', '-m', 'add ' + name); if (fs.existsSync(path.join(fx.notes, 'task.json'))) selfRead(fx); };

test('ready: the tests-only lane asks for no proof entry; the normal lane still does', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  addFile(fx, 'a.test.js', "import test from 'node:test';\ntest('a', () => {});\n");
  fx.notesList = { known: true, all: [] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — proof:/);
  gitIn(fx.repo, 'config', 'sanad.testsOnlyLane', 'true');
  const out = (await runIn(fx, 'ready')).out;
  assert.doesNotMatch(out, /— proof:/);
  assert.match(out, /READY lane: tests-only/);
});

test('ready: the tests-only lane is judged on the code now; a saved label and a product file in the diff bring the proof back', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  gitIn(fx.repo, 'config', 'sanad.testsOnlyLane', 'true');
  addFile(fx, 'a.test.js', "import test from 'node:test';\ntest('a', () => {});\n");
  note(fx, 'size.json', JSON.stringify({ testsOnly: true }));
  fx.notesList = { known: true, all: [] };
  assert.doesNotMatch((await runIn(fx, 'ready')).out, /— proof:/);
  addFile(fx, 'b.js', 'export const b = 1;\n');
  const out = (await runIn(fx, 'ready')).out;
  assert.match(out, /READY NOT DONE — proof:/);
  assert.match(out, /READY lane: normal/);
  // A saved label alone never makes the lane light.
  const fy = fixture();
  start(fy);
  upToSize(fy);
  gitIn(fy.repo, 'config', 'sanad.testsOnlyLane', 'true');
  commit(fy, 'export const a = 2;\n');
  note(fy, 'size.json', JSON.stringify({ testsOnly: true }));
  fy.notesList = { known: true, all: [] };
  assert.match((await runIn(fy, 'ready')).out, /READY NOT DONE — proof:/);
});

test('U3: a saved tiny size with a test file in the change gets the breaks and proof steps, and ready lists the proof', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  note(fx, 'size.txt', 'tiny\n');
  fx.notesList = { known: true, all: [] };
  addFile(fx, 'a.test.js', "import test from 'node:test';\ntest('a', () => {});\n");
  const facts = readFacts({ repo: fx.repo, notes: fx.notes });
  assert.equal(facts.lane, 'text');
  assert.equal(facts.textProof, true);
  const next = run(fx, 'next').out;
  assert.ok(stepsOf(next).some((s) => ['breaks', 'proof', 'checks-before-proof'].includes(s)), next);
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — proof:/);
  // With the lane switch on and tests only, the light lane is back: no proof.
  gitIn(fx.repo, 'config', 'sanad.testsOnlyLane', 'true');
  assert.doesNotMatch((await runIn(fx, 'ready')).out, /— proof:/);
  // A doc-only tiny change has no proof, switch off.
  const fy = fixture();
  start(fy);
  upToSize(fy);
  note(fy, 'size.txt', 'tiny\n');
  addFile(fy, 'README.md', '# hi\n');
  assert.equal(readFacts({ repo: fy.repo, notes: fy.notes }).textProof, false);
  fy.notesList = { known: true, all: [] };
  assert.doesNotMatch((await runIn(fy, 'ready')).out, /— proof:/);
});

test('U3: a saved tiny size is judged again on the code now; product code brings the full path back', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  note(fx, 'size.txt', 'tiny\n');
  addFile(fx, 'README.md', '# hi\n');
  assert.equal(readFacts({ repo: fx.repo, notes: fx.notes }).lane, 'text');
  addFile(fx, 'b.js', 'export const b = 1;\n');
  const f = readFacts({ repo: fx.repo, notes: fx.notes });
  assert.notEqual(f.lane, 'text');
  fx.notesList = { known: true, all: [] };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — proof:/);
});

test('U3: a tree called foreign is not judged again: the saved tiny stays and next stays fast', () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  note(fx, 'size.txt', 'tiny\n');
  addFile(fx, 'b.js', 'export const b = 1;\n');
  const other = path.join(fx.repo, 'other session');
  fs.mkdirSync(other);
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(other, `f${i}.txt`), 'x' + i);
  const f = readFacts({ repo: fx.repo, notes: fx.notes });
  assert.equal(f.git.foreign, true);
  assert.equal(f.lane, 'text');
});

test('U3: with no session scan, ready counts the seats from the report files newer than the pin', async () => {
  const fx = fixture();
  start(fx);
  upToSize(fx);
  const head = commit(fx, 'export const a = 2;\n');
  note(fx, 'engine.txt', 'codex\n');
  pinFile(fx, [{ round: 1, kind: 'full', commit: head, at: '2026-11-19T10:00:00.000Z', seats: ['fresh eyes', 'risk files', 'whole diff'] }]);
  fx.notesList = { known: true, all: [] }; // no `reviews`: no scan
  const put = (name, text, when) => { const file = path.join(fx.notes, name); fs.writeFileSync(file, text); fs.utimesSync(file, new Date(when), new Date(when)); };
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: /);
  put('codex-fresh.md', 'PASS\n', '2026-11-19T10:05:00.000Z');
  put('codex-risk.md', 'PASS\n', '2026-11-19T10:06:00.000Z');
  put('codex-whole.md', '', '2026-11-19T10:07:00.000Z'); // an empty file is no report
  let out = (await runIn(fx, 'ready')).out;
  assert.match(out, /READY NOT DONE — review: .*only 2 of 3/);
  put('codex-whole.md', 'PASS\n', '2026-11-19T09:00:00.000Z'); // older than the pin
  assert.match((await runIn(fx, 'ready')).out, /READY NOT DONE — review: .*only 2 of 3/);
  put('codex-whole.md', 'PASS\n', '2026-11-19T10:07:00.000Z');
  out = (await runIn(fx, 'ready')).out;
  assert.match(out, /READY done     — review:/);
  assert.match(out, /READY note — review: no session scan is available; the seats were counted from the report files/);
  // With a scan the files are not the count.
  fx.notesList = { known: true, all: [], reviews: [] };
  assert.doesNotMatch((await runIn(fx, 'ready')).out, /counted from the report files/);
});

// 2026-11-20 (timed task): the author named ticket-text.md, breaks-page.json and proof-page.log; later steps asked for
// ticket.md, breaks.json and proof-tests.log, and files were copied by hand. start prints the file names once, and the
// review step passes every proof log that is in the folder.
test('start prints the task folder file names once, one proof log per side; next passes every proof*.log to the review brief', async () => {
  const fx = fixture();
  const first = start(fx);
  assert.equal(first.status, 0, first.out);
  const n = fx.notes.replace(/\\/g, '/');
  const files = first.out.split('\n').filter((l) => l.startsWith('FILES in '));
  assert.equal(files.length, 1, first.out);
  for (const name of ['ticket-text.md', 'ticket.md', 'lines.md', 'check.md', 'places.md', 'siblings-report.md', 'siblings.md', 'breaks.json', 'proof-page.log']) assert.ok(files[0].includes(name), name + ' in ' + files[0]);
  assert.ok(files[0].startsWith(`FILES in ${n}:`), files[0]);
  const second = run(fx, 'start', '--repo', fx.repo, '--notes', fx.notes, '--side', 'server', '--', 'dotnet', 'test');
  assert.match(second.out, /^FILES in .*proof-page\.log, proof-server\.log/m);
  // Two logs in the folder: the printed review-brief command names both.
  upToSize(fx);
  note(fx, 'breaks.json', JSON.stringify([{ find: 'a', put: 'b' }]));
  note(fx, 'proof-page.log', 'x\n');
  note(fx, 'proof-server.log', 'x\n');
  commit(fx, 'export const a = 2;\n');
  proved(fx, { command: ['node', '--test', 'a.test.mjs'], cwd: '' });
  const { recordKey } = await import('../scripts/proof-record.mjs');
  process.env.SANAD_STATE_DIR = fx.state;
  writeEntry(fx.repo, recordKey(['dotnet', 'test'], ''), { ok: true, breaks: 1, code: codeFingerprint(fx.repo), files: {}, targets: {}, caught: {}, command: ['dotnet', 'test'], cwd: '' });
  const out = (await runIn(fx, 'next')).out;
  assert.ok(out.includes(`--proof-log ${n}/proof-page.log --proof-log ${n}/proof-server.log `), out);
});

// 2026-11-20 (fix round 1b): the best design closed "not:" by a hand edit of siblings.md is open for `next` too.
// 2026-11-22 (owner): a hint is advice; an older list's BEST DESIGN line locks nothing, and only a too-short reason is open.
test('next counts a J line closed not: with a too-short reason as open, and a BEST DESIGN line of an older list locks nothing', async () => {
  const fx = fixture();
  start(fx);
  note(fx, 'lines.md', 'T1 the list shows the due date\n');
  note(fx, 'places.md', 'P1 · a.js · lines 1 → C1\n');
  const list = (outcome) => 'Recorded: 2026-11-20T10:00:00.000Z\n\nSIBLINGS: none\n\nJ1 · src/a.ts:1 · a — one read → reuse\nJ2 · src/b.ts:2 · b — one worker → ' + outcome + '\n\nBEST DESIGN: J2 — one worker drains everything\n';
  note(fx, 'siblings.md', list('not: it sends to another system with its own order'));
  note(fx, 'check.md', '[T1] the due date is shown\n');
  note(fx, 'size.txt', 'small\n');
  const f = readFacts({ repo: fx.repo, notes: fx.notes });
  assert.equal(f.open.siblings, 0, 'a not: with its reason is closed, BEST DESIGN line or not');
  note(fx, 'siblings.md', list('not: no'));
  assert.equal(readFacts({ repo: fx.repo, notes: fx.notes }).open.siblings, 1, 'a too-short reason is open');
});

// 2026-11-22 (attack): the early review waited for a log line no proof ever wrote. It now reads the lines the proof
// writes as it runs, for the tree under review only, and needs every side.
test('early review: a log of this tree with the passing run and the old-code run red; another tree or a missing side is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-'));
  const tree = 'a'.repeat(40), other = 'b'.repeat(40);
  const log = (name, t, body) => { const p = path.join(dir, name); fs.writeFileSync(p, 'RED-PROOF-LOG: tree ' + t + ' at 2026-11-22T05:00:00.000Z\n' + body); return p; };
  const both = '  ran green: exit 0 (5 s)\n  ran old code: exit 1 (6 s)\n';
  const page = log('proof-page.log', tree, both);
  assert.equal(proofStartedEarly([page], tree, 1), true);
  assert.equal(proofStartedEarly([log('proof-old.log', other, both)], tree, 1), false, 'a log of another tree');
  assert.equal(proofStartedEarly([log('proof-green.log', tree, '  ran green: exit 0 (5 s)\n')], tree, 1), false, 'old code not run yet');
  assert.equal(proofStartedEarly([log('proof-same.log', tree, '  ran green: exit 0 (5 s)\n  ran old code: exit 0 (6 s)\n')], tree, 1), false, 'old code passed: no red');
  assert.equal(proofStartedEarly([page], tree, 2), false, 'a page and a server side need two logs');
  assert.equal(proofStartedEarly([page, log('proof-server.log', tree, both)], tree, 2), true);
  assert.equal(proofStartedEarly([page], '', 1), false, 'no tree');
});
