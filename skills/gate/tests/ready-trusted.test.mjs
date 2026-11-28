// 2026-11-28 (owner, batch b task 1): "ready" says yes only on records the guards trust — the evidence receipt of the exact
// tree the session shows and the scanner read as passing, the proof record, the hooks' review record and the scanner's
// reviewer runs, and a whole pre-review run whose run the session shows. Never on a file in the notes folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/sanad.mjs';
import { writeEntry, codeFingerprint } from '../scripts/proof-record.mjs';
import { rememberFullRun, notesInputs, BEFORE_PROOF_FILES } from '../scripts/pre-review-cache.mjs';
import { recordLine, firstRound, seenReceipts, seenRecord } from '../scripts/trusted.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-ready-trusted-'));
const emptyConfig = path.join(root, 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
const gitIn = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
let cases = 0;
function fixture() {
  const dir = path.join(root, 'case-' + (++cases));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'base');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  gitIn(repo, 'add', 'a.js');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  gitIn(repo, 'checkout', '-q', '-b', 'feat');
  const fx = { dir, repo, notes: path.join(dir, 'notes'), state: path.join(dir, 'state') };
  process.env.SANAD_STATE_DIR = fx.state;
  return fx;
}
const note = (fx, name, text) => fs.writeFileSync(path.join(fx.notes, name), text);
async function cmd(fx, name, ...args) {
  process.env.SANAD_STATE_DIR = fx.state;
  const lines = [];
  const status = await main([name, '--repo', fx.repo, ...args], (l) => lines.push(l), { sessionNotes: () => fx.notesList, trust: fx.trust });
  return { status, out: lines.join('\n') };
}
// A task that reached the size line, with one commit of the fix.
async function task(fx) {
  await cmd(fx, 'start', '--notes', fx.notes, '--base', 'base', '--suite', 'node run full-suite', '--side', 'page', '--fix-files', 'a.js', '--', 'node', '--test', 'a.test.mjs');
  note(fx, 'lines.md', 'T1. the list shows the due date\n');
  note(fx, 'places.md', 'P1 · a.js · lines 1 → C1\n');
  note(fx, 'siblings.md', 'S1 · b.js:3 the same rule → none: not the same rule\n');
  note(fx, 'check.md', '[T1] the due date is shown\n');
  note(fx, 'size.txt', 'small\n');
  fs.writeFileSync(path.join(fx.repo, 'a.js'), 'export const a = 2;\n');
  gitIn(fx.repo, 'commit', '-q', '-am', 'fix');
  fx.head = gitIn(fx.repo, 'rev-parse', 'HEAD');
  fx.tree = gitIn(fx.repo, 'rev-parse', 'HEAD^{tree}');
  // The task started before the fixed reviewer times below (start wrote today's time).
  const file = path.join(fx.notes, 'task.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), startedAt: '2026-11-28T07:00:00.000Z' }));
}
const RUN_ID = '0f8b5c9e-1d2a-4b3c-8d4e-5f6a7b8c9d0e';
// The tools' own folder: a run counts only as `node <the installed tool>` (trusted.mjs isToolRun).
const GATE = decodeURIComponent(new URL('../scripts/', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const evidenceRun = (fx, args = ['run', 'full-suite'], tree = fx.tree) => ({ id: 'e1', at: '2026-11-28T10:00:00Z',
  command: `node ${GATE}/evidence.mjs --spec s.json`,
  output: 'CHECK_COMPLETED ' + JSON.stringify({ runId: RUN_ID, status: 'passed', nativeExitCode: 0, cwd: fx.repo, executable: 'node', args, source: { treeBefore: tree, treeAfter: tree } }) });
const passingFor = (fx, tree = fx.tree) => [{ toplevel: fx.repo.replace(/\\/g, '/'), treeBefore: tree, treeAfter: tree, cwd: fx.repo.replace(/\\/g, '/') }];
const fullRun = (fx) => {
  process.env.SANAD_STATE_DIR = fx.state;
  const inputs = notesInputs(BEFORE_PROOF_FILES.map((n) => path.join(fx.notes, n)));
  const record = rememberFullRun(fx.repo, { tree: fx.tree, head: fx.head, base: 'base', inputs });
  return { id: 'p1', at: '2026-11-28T10:01:00Z', command: `node ${GATE}/pre-review.mjs --notes ${fx.notes.replace(/\\/g, '/')}`, output: `PRE-REVIEW: 9 of 9 checks passed\n${recordLine('pre-review', fx.tree, record)}` };
};
// The session's own start of this task (hole 5): `sanad.mjs start` printed the notes folder.
const startRun = (fx, at = '2026-11-28T08:00:00Z') => ({ id: 's0', at, command: `node ${GATE}/sanad.mjs start --repo ${fx.repo.replace(/\\/g, '/')} --notes ${fx.notes.replace(/\\/g, '/')}`, output: `START: task notes ${fx.notes.replace(/\\/g, '/')} for ${fx.repo}\nFILES in …` });
const store = (fx, head = fx.head, tree = fx.tree) => ({ identity: () => 'dir:x', load: () => [{ repo: 'dir:x', commits: [head], head, tree, base: 'b' }] });
const fresh = { id: 'r1', seat: 'fresh eyes', launchAt: '2026-11-28T09:00:00Z', doneAt: '2026-11-28T09:10:00Z' };
const recheck = { id: 'r2', seat: 're-check', launchAt: '2026-11-28T09:30:00Z', doneAt: '2026-11-28T09:35:00Z' };
// The reviewer launch prompts of the session (review, task 1 PR): each names a brief in this task's notes folder.
class Prompts extends Map { constructor(text) { super(); this.text = text; } get(id) { return super.has(id) ? super.get(id) : this.text; } }
const promptsFor = (fx) => new Prompts(`You are the independent reviewer — FRESH EYES. Read the brief at ${fx.notes.replace(/\\/g, '/')}/brief-fresh.md`);
// The other engine's report file in the notes folder, finished at `at` (codex-review.md on a Claude task).
function otherReport(fx, at, name = 'codex-review.md') {
  const file = path.join(fx.notes, name);
  fs.writeFileSync(file, 'RECOMMEND: PASS\n');
  fs.utimesSync(file, new Date(at), new Date(at));
  return file;
}
// Everything trusted for a small task: the review record, the fresh-eyes run, the other engine's report, the suite
// receipt and the whole pre-review run.
function allTrusted(fx) {
  fx.notesList = { known: true, all: [], reviews: [fresh], passing: passingFor(fx), transcript: '' };
  fx.trust = { size: 'small', reviewStore: store(fx), runs: [startRun(fx), evidenceRun(fx), fullRun(fx)], prompts: promptsFor(fx) };
  // 2026-11-28 (owner, batch c task 2): a small change has the other engine's seat too: its report file, after the
  // first round began.
  otherReport(fx, '2026-11-28T09:15:00Z');
  process.env.SANAD_STATE_DIR = fx.state;
  writeEntry(fx.repo, 'k1', { ok: true, breaks: 2, code: codeFingerprint(fx.repo), files: {}, targets: {}, caught: {} });
}
const item = (out, id) => (new RegExp(`^READY (done    |NOT DONE) — ${id}: (.*)$`, 'm').exec(out) || [])[0] || '';

test('ready: every item is done on the trusted records alone', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  const out = (await cmd(fx, 'ready')).out;
  for (const id of ['review', 'notes', 'proof', 'suite', 'ticket lines', 'one commit']) assert.match(item(out, id), /^READY done/, `${id}\n${out}`);
  assert.match(item(out, 'suite'), /passed on this tree: `node run full-suite` \(from task\.json; receipt 0f8b5c9e/);
});

test('ready: a pin in the notes folder and a finished run are no review without the hooks\' review record', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  note(fx, 'review-pin.json', JSON.stringify({ version: 1, pins: [{ round: 1, kind: 'full', commit: fx.head, at: '2026-11-28T08:00:00Z' }] }));
  fx.trust.reviewStore = { identity: () => 'dir:x', load: () => [] };
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY NOT DONE — review: no accepted REVIEW: PASS is on the review record for HEAD .*write the REVIEW line/);
  // A record of another commit is not this one's.
  fx.trust.reviewStore = store(fx, 'f'.repeat(40));
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY NOT DONE/);
});

test('ready: a re-check never fills a first-round seat', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fx.notesList.reviews = [recheck];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY NOT DONE — review: .*0 of 2 first-round seat\(s\) of a small change .*missing fresh eyes/);
  // A run that names no seat ('reviewer') is no fresh-eyes run either.
  fx.notesList.reviews = [{ ...fresh, seat: 'reviewer' }, recheck];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing fresh eyes/);
  fx.notesList.reviews = [fresh, recheck];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY done/);
});

// 2026-11-28 (owner, batch c task 2): a Claude task's big round is fresh eyes, the risk files and the other engine (no
// whole-diff seat); a Codex task keeps its whole diff, four seats.
test('ready: a big change needs each of its first-round seats; the other engine is its report file after the first round began', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fx.trust.size = 'big';
  const seat = (s, id) => ({ id, seat: s, launchAt: '2026-11-28T09:00:00Z', doneAt: '2026-11-28T09:20:00Z' });
  const file = otherReport(fx, '2026-11-28T08:00:00Z');
  fx.notesList.reviews = [seat('fresh eyes', 'a'), recheck];
  let out = item((await cmd(fx, 'ready')).out, 'review');
  assert.match(out, /1 of 3 first-round seat\(s\) of a big change .*missing risk files, other engine/);
  fx.notesList.reviews.push(seat('risk files', 'b'));
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing other engine/);
  fs.utimesSync(file, new Date('2026-11-28T09:15:00Z'), new Date('2026-11-28T09:15:00Z'));
  out = item((await cmd(fx, 'ready')).out, 'review');
  assert.match(out, /^READY done/, out);
  // A Codex task: its own whole-diff seat is still needed, and the other engine is a claude-* report.
  note(fx, 'engine.txt', 'codex\n');
  const task2 = path.join(fx.notes, 'task.json');
  fs.writeFileSync(task2, JSON.stringify({ ...JSON.parse(fs.readFileSync(task2, 'utf8')), engine: 'codex' }));
  out = item((await cmd(fx, 'ready')).out, 'review');
  assert.match(out, /of 4 first-round seat\(s\) of a big change .*missing whole diff, other engine/, out);
  fx.notesList.reviews.push(seat('whole diff', 'c'));
  otherReport(fx, '2026-11-28T09:15:00Z', 'claude-fresh.md');
  out = item((await cmd(fx, 'ready')).out, 'review');
  assert.match(out, /^READY done/, out);
  // A size typed into the notes folder may raise the seats, never lower them.
  fx.trust.size = 'small';
  note(fx, 'size.txt', 'big\n');
  fx.notesList.reviews = [seat('fresh eyes', 'a')];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /of a big change/);
});

test('ready: a suite receipt file in the notes folder is no suite; the session must show it and the scanner read it as passing', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fs.mkdirSync(path.join(fx.notes, 'evidence', 'check-1'), { recursive: true });
  fs.writeFileSync(path.join(fx.notes, 'evidence', 'check-1', 'metadata.json'), JSON.stringify({ runId: 'r1', status: 'passed', executable: 'node', args: ['run', 'full-suite'], source: { treeBefore: fx.tree, treeAfter: fx.tree } }));
  fx.trust.runs = [fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE — suite: no passing receipt of `node run full-suite` \(from task\.json\) on this tree is seen in the session/);
  // Shown in the session, but the scanner did not read it as passing.
  fx.trust.runs = [evidenceRun(fx), fullRun(fx)];
  fx.notesList.passing = [];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE/);
  // A receipt of another tree, and a filtered command, are not the suite of this tree.
  fx.notesList.passing = passingFor(fx, 'a'.repeat(40));
  fx.trust.runs = [evidenceRun(fx, ['run', 'full-suite'], 'a'.repeat(40)), fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE/);
  fx.notesList.passing = passingFor(fx);
  fx.trust.runs = [evidenceRun(fx, ['run', 'full-suite', '--grep', 'one']), fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE/);
  // An echo of the receipt line is no evidence.mjs run.
  fx.trust.runs = [{ ...evidenceRun(fx), command: 'echo CHECK_COMPLETED evidence.mjs' }, fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE/);
});

test('ready: the repository setting names the suite before task.json, and ready prints the command it accepted', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  gitIn(fx.repo, 'config', 'sanad.suite', "node run 'spec files/all.mjs'");
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE — suite: no passing receipt of `node run 'spec files\/all\.mjs'` \(from git config sanad\.suite\)/);
  fx.trust.runs = [evidenceRun(fx, ['run', 'spec', 'files/all.mjs']), fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE/);
  fx.trust.runs = [evidenceRun(fx, ['run', 'spec files/all.mjs']), fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY done     — suite: passed on this tree: `node run 'spec files\/all\.mjs'` \(from git config sanad\.suite;/);
});

test('ready: the ticket lines need a whole pre-review run of this tree that the session shows; the record alone or an echo is not enough', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  const real = fullRun(fx);
  fx.trust.runs = [evidenceRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'ticket lines'), /^READY NOT DONE — ticket lines: the session does not show the pre-review run that wrote its record for this tree: run node .*pre-review\.mjs/);
  fx.trust.runs = [evidenceRun(fx), { ...real, command: `echo "${real.output.split('\n')[1]}"  # pre-review.mjs` }];
  assert.match(item((await cmd(fx, 'ready')).out, 'ticket lines'), /^READY NOT DONE/);
  // A list file changed after the run: the record is for other lists.
  fx.trust.runs = [evidenceRun(fx), real];
  note(fx, 'check.md', '[T1] the due date is shown\n[change] the list is sorted\n');
  assert.match(item((await cmd(fx, 'ready')).out, 'ticket lines'), /^READY NOT DONE — ticket lines: the last whole pre-review run that passed was on other code, another base or other list files/);
  // Open places in a list file are no longer read as the answer: the run's record is.
  note(fx, 'check.md', '[T1] the due date is shown\n');
  assert.match(item((await cmd(fx, 'ready')).out, 'ticket lines'), /^READY done/);
});

test('ready: the base is the repository\'s integration branch; task.json\'s base counts only when none is set', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  assert.match(item((await cmd(fx, 'ready')).out, 'one commit'), /^READY done     — one commit: 1 commit\(s\) on base/);
  gitIn(fx.repo, 'branch', 'other', 'base');
  gitIn(fx.repo, 'update-ref', 'refs/remotes/origin/other', 'base');
  gitIn(fx.repo, 'config', 'sanad.integration', 'other');
  assert.match(item((await cmd(fx, 'ready')).out, 'one commit'), /on origin\/other/);
});

test('trusted.mjs: the small readers fail closed', () => {
  assert.deepEqual(firstRound(['fresh eyes'], null).missing, ['fresh eyes']);
  assert.deepEqual(firstRound(['other engine'], [fresh], [Date.parse('2026-11-28T09:05:00Z')]).missing, []);
  assert.deepEqual(firstRound(['other engine'], [recheck], [Date.parse('2026-11-28T09:40:00Z')]).missing, ['other engine'], 'a re-check is not the first round');
  assert.deepEqual(seenReceipts([{ command: 'node evidence.mjs -- x', output: 'CHECK_COMPLETED {broken' }], []), []);
  assert.equal(seenRecord([], { toolFile: 'pre-review.mjs', kind: 'pre-review', tree: 'a'.repeat(40), record: { a: 1 } }), false);
});

// ---- The five holes of the review (2026-11-28, task 1 as its own PR) ----

// Hole 1 (owner: count only in this PR). The plain shapes; everything else is counted, never refused.
test('hole 1: the plain shapes of a tool call, and the shapes that are not plain', async () => {
  const { isToolRun } = await import('../scripts/trusted.mjs');
  const T = `${GATE}/pre-review.mjs`;
  const plain = (c) => isToolRun(c, 'pre-review.mjs');
  for (const c of [`node ${T} --notes N`, `cd C:/x && node ${T} --notes N`, `N=C:/notes && node ${T} --notes $N/x`, `cd /c/x && N=C:/n && node ${T} --was small 2>&1`,
    `node ${T} --notes N 2>&1 | tail -40`, `node ${T} | tail -5`, `"node" '${T}' --notes 'a b'`]) assert.equal(plain(c), true, 'plain: ' + c);
  for (const c of [`node ${T} --notes N 2>&1 | grep -v ok`, `node ${T} | sed s/a/b/`, `node ${T}; echo done`, `git add a && node ${T}`, `node ${T} --notes $(pwd)`,
    `node -e "console.log(1)" # ${T}`, `cat ${T}`, `NODE_OPTIONS=x node ${T}`, `node /elsewhere/pre-review.mjs`, `node $GATE/pre-review.mjs`, `node ${T} || true`, `node ${T}\nnode ${T}`])
    assert.equal(plain(c), false, 'not plain: ' + c);
});

test('hole 1: a record line from a call that ran other commands too still counts, and ready says how many and their shapes', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  const real = fullRun(fx);
  fx.trust.runs = [startRun(fx), evidenceRun(fx), { ...real, command: `cd ${fx.repo.replace(/\\/g, '/')} && git add a.js && node ${GATE}/pre-review.mjs --notes x` }];
  const out = (await cmd(fx, 'ready')).out;
  assert.match(item(out, 'ticket lines'), /^READY done/, 'nothing is refused for its shape');
  assert.match(out, /^READY note — records: 1 record line\(s\) came from a call that ran other commands too \(1 × other commands in the same call\); counted only, nothing refused$/m);
  fx.trust.runs = [startRun(fx), evidenceRun(fx), fullRun(fx)];
  assert.doesNotMatch((await cmd(fx, 'ready')).out, /READY note — records/, 'plain calls give no line');
});

// A session log holding one evidence.mjs run that printed a passing receipt of `args` on `tree`.
function sessionLog(fx, args, tree = fx.tree) {
  const file = path.join(fx.dir, 'session-' + (++cases) + '.jsonl');
  const rec = { runId: RUN_ID, status: 'passed', nativeExitCode: 0, cwd: fx.repo, executable: 'node', args, source: { treeBefore: tree, treeAfter: tree } };
  fs.writeFileSync(file, [
    { type: 'assistant', timestamp: '2026-11-28T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `node ${GATE}/evidence.mjs --spec s.json` } }] } },
    { type: 'user', timestamp: '2026-11-28T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'CHECK_COMPLETED ' + JSON.stringify(rec) }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { transcript: file, scan: { passingReceipts: passingFor(fx, tree) } };
}

test('hole 2: the gate never reads its records from a session log or report files the caller names', async () => {
  const fx = fixture();
  await task(fx);
  const { gateRecords } = await import('../scripts/notes.mjs');
  const list = sessionLog(fx, ['run', 'full-suite']);
  for (const o of [{ repo: fx.repo, notes: fx.notes, transcript: list.transcript }, { repo: fx.repo, notes: fx.notes, reports: 'r.md' }]) {
    const r = await gateRecords(o, list);
    assert.equal(r.tests.ok, false, JSON.stringify(o));
    assert.match(r.tests.why, /reads its records only from this repository's own session log/);
  }
  assert.equal((await gateRecords({ repo: fx.repo, notes: fx.notes }, list)).tests.ok, true, 'the log the tool found itself is read');
});

test('hole 3: the gate\'s test receipt is the suite command\'s, not any passing receipt of the tree', async () => {
  const fx = fixture();
  await task(fx);
  const { gateRecords } = await import('../scripts/notes.mjs');
  const one = await gateRecords({ repo: fx.repo, notes: fx.notes }, sessionLog(fx, ['--test', 'one.test.mjs']));
  assert.equal(one.tests.ok, false);
  assert.match(one.tests.why, /no passing receipt of `node run full-suite` \(from task\.json\) on this tree/);
  const suite = await gateRecords({ repo: fx.repo, notes: fx.notes }, sessionLog(fx, ['run', 'full-suite']));
  assert.equal(suite.tests.ok, true);
  assert.equal(suite.tests.command, 'node run full-suite (from task.json)');
  // The repository's own setting comes first.
  gitIn(fx.repo, 'config', 'sanad.suite', 'npm test');
  assert.equal((await gateRecords({ repo: fx.repo, notes: fx.notes }, sessionLog(fx, ['run', 'full-suite']))).tests.ok, false);
});

test('hole 4: "left to CI" only when the change, sized now, is small; a typed small size never decides it', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  const file = path.join(fx.notes, 'task.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), suiteCi: 'ci: full' }));
  fx.trust.runs = [startRun(fx), fullRun(fx)];
  fx.trust.size = 'big';
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE — suite: .*\(left to CI is only for a small change; sized now it is big\)/);
  fx.trust.size = 'small';
  assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY done {5}— suite: left to CI: ci: full \(named in task\.json; the change sized now is small\)/);
});

test('hole 4: the gate sizes the change now, once, never from a kept answer', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  delete fx.trust.size;
  const { keptSizeKey } = await import('../scripts/size-check.mjs');
  const { writeKept } = await import('../scripts/kept.mjs');
  process.env.SANAD_STATE_DIR = fx.state;
  writeKept('size', fx.repo, keptSizeKey(fx.repo, 'base').key, { size: 'big', roles: [], signals: {}, callers: [] });
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /of a small change/, 'the kept "big" answer is not read');
});

test('hole 5: a seat counts only for a run after this task\'s start in this session, or a linked one', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  // No start of this task in the session: no seat, and the line names the one command that fixes it.
  fx.trust.runs = [evidenceRun(fx), fullRun(fx)];
  const none = item((await cmd(fx, 'ready')).out, 'review');
  assert.match(none, /^READY NOT DONE — review: .*this session shows no start of this task, so no reviewer run can be tied to it: run node \S*sanad\.mjs start --repo \S+ --notes \S+ in this session, then the first-round reviews/);
  // A start after the fresh-eyes run: that run was another task's.
  fx.trust.runs = [startRun(fx, '2026-11-28T09:20:00Z'), evidenceRun(fx), fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing fresh eyes/);
  // A start of another notes folder is not this task's.
  fx.trust.runs = [{ ...startRun(fx), output: 'START: task notes C:/other/notes for x' }, evidenceRun(fx), fullRun(fx)];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /no start of this task/);
  // task.json's start time, when later than the start call, is the bound.
  fx.trust.runs = [startRun(fx), evidenceRun(fx), fullRun(fx)];
  const file = path.join(fx.notes, 'task.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), startedAt: '2026-11-28T09:30:00.000Z' }));
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing fresh eyes/);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), startedAt: '2026-11-28T07:00:00.000Z' }));
  // The start found in a linked earlier session of the same notes folder counts (the owner's link, once it exists).
  const linked = path.join(fx.dir, 'linked.jsonl');
  const s = startRun(fx);
  fs.writeFileSync(linked, [
    { type: 'assistant', timestamp: s.at, message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: s.command } }] } },
    { type: 'user', timestamp: s.at, message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: s.output }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  fx.trust.runs = [evidenceRun(fx), fullRun(fx)];
  fx.trust.linkedLogs = [linked];
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY done/);
});

// ---- The holes the two reviews of the task 1 PR found (each test fails on the code before its fix) ----

test('review: no check lines is no ticket-lines pass, in ready and at the gate, even with a whole pre-review run', async () => {
  const fx = fixture();
  await task(fx);
  fs.writeFileSync(path.join(fx.notes, 'check.md'), '   \n');
  allTrusted(fx);
  assert.match(item((await cmd(fx, 'ready')).out, 'ticket lines'), /^READY NOT DONE — ticket lines: no check lines \(check\.md is missing or blank\)/);
  const { gateRecords } = await import('../scripts/notes.mjs');
  const log = sessionLog(fx, ['run', 'full-suite']);
  fs.appendFileSync(log.transcript, [
    { type: 'assistant', timestamp: '2026-11-28T10:02:00Z', message: { content: [{ type: 'tool_use', id: 'p9', name: 'Bash', input: { command: fullRun(fx).command } }] } },
    { type: 'user', timestamp: '2026-11-28T10:03:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'p9', content: fullRun(fx).output }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = await gateRecords({ repo: fx.repo, notes: fx.notes }, log);
  assert.equal(r.lines.ok, false);
  assert.match(r.lines.why, /no check lines/);
});

test('review: the gate\'s review is the review record of HEAD; its proof is the proof record', async () => {
  const fx = fixture();
  await task(fx);
  const { gateRecords } = await import('../scripts/notes.mjs');
  const list = sessionLog(fx, ['run', 'full-suite']);
  const none = await gateRecords({ repo: fx.repo, notes: fx.notes, reviewStore: { identity: () => 'dir:x', load: () => [] } }, list);
  assert.equal(none.review.ok, false);
  assert.match(none.review.why, /no accepted REVIEW: PASS is on the review record for HEAD/);
  assert.equal((await gateRecords({ repo: fx.repo, notes: fx.notes, reviewStore: store(fx) }, list)).review.ok, true);
  // No PROVED entry of this tree: no proof; one of this tree: proof.
  process.env.SANAD_STATE_DIR = fx.state;
  assert.equal(none.proof.ok, false);
  writeEntry(fx.repo, 'k1', { ok: true, breaks: 2, code: codeFingerprint(fx.repo), files: {}, targets: {}, caught: {} });
  assert.equal((await gateRecords({ repo: fx.repo, notes: fx.notes, reviewStore: store(fx) }, list)).proof.ok, true);
});

test('review: SANAD_PROJECTS_DIR makes the session log one the caller chose: no record, in ready and at the gate', async () => {
  const fx = fixture();
  await task(fx);
  const { gateRecords } = await import('../scripts/notes.mjs');
  const list = sessionLog(fx, ['run', 'full-suite']);
  process.env.SANAD_PROJECTS_DIR = path.join(fx.dir, 'projects');
  try {
    const r = await gateRecords({ repo: fx.repo, notes: fx.notes }, list);
    assert.equal(r.tests.ok, false);
    assert.match(r.tests.why, /SANAD_PROJECTS_DIR is set/);
    allTrusted(fx);
    delete fx.trust.runs;   // read from the session log, as a real run does
    fx.notesList.transcript = list.transcript;
    assert.match(item((await cmd(fx, 'ready')).out, 'suite'), /^READY NOT DONE — suite: SANAD_PROJECTS_DIR is set/);
  } finally { delete process.env.SANAD_PROJECTS_DIR; }
});

test('review: one scanner pass never stands for two receipts of one tree and folder; a later failure takes the pass back', async () => {
  const { seenReceipts } = await import('../scripts/trusted.mjs');
  const T = 'c'.repeat(40);
  const rec = (runId, args, status = 'passed') => ({ runId, status, nativeExitCode: status === 'passed' ? 0 : 1, cwd: 'C:/r', executable: 'node', args, source: { treeBefore: T, treeAfter: T } });
  const call = (r) => ({ command: `node ${GATE}/evidence.mjs --spec s.json`, output: 'CHECK_COMPLETED ' + JSON.stringify(r) });
  const one = [{ treeBefore: T, treeAfter: T, cwd: 'C:/r' }];
  const lintAndSuite = [call(rec('11111111-1111-1111-1111-111111111111', ['lint'])), call(rec('22222222-2222-2222-2222-222222222222', ['run', 'full-suite']))];
  assert.deepEqual(seenReceipts(lintAndSuite, one), [], 'two passing receipts, one scanner pass: none counts');
  assert.equal(seenReceipts(lintAndSuite, [...one, ...one]).length, 2, 'one scanner pass each: both count');
  const passThenFail = [call(rec('33333333-3333-3333-3333-333333333333', ['run', 'full-suite'])), call(rec('44444444-4444-4444-4444-444444444444', ['run', 'full-suite'], 'failed'))];
  assert.deepEqual(seenReceipts(passThenFail, one), [], 'the later failure of the same command on the same tree takes the pass back');
});

test('review: a reviewer run counts for this task only when its launch prompt names this task\'s notes folder', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fx.trust.prompts = new Map([['r1', 'You are the independent reviewer — FRESH EYES. Read the brief at C:/other-task/notes/brief-fresh.md']]);
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing fresh eyes/);
  fx.trust.prompts = new Map();
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing fresh eyes/, 'a run with no prompt on record');
  fx.trust.prompts = promptsFor(fx);
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY done/);
});

test('review: the other engine\'s re-check report never fills its first-round seat', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fx.trust.size = 'medium';
  fs.rmSync(path.join(fx.notes, 'codex-review.md'));   // the setup's first-round report: this test adds its own
  const file = path.join(fx.notes, 'codex-recheck-2.md');
  fs.writeFileSync(file, 'RECOMMEND: PASS\n');
  fs.utimesSync(file, new Date('2026-11-28T09:40:00Z'), new Date('2026-11-28T09:40:00Z'));
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /missing other engine/);
  const first = path.join(fx.notes, 'codex-review.md');
  fs.writeFileSync(first, 'RECOMMEND: PASS\n');
  fs.utimesSync(first, new Date('2026-11-28T09:20:00Z'), new Date('2026-11-28T09:20:00Z'));
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY done/);
});

test('review: a seat list that cannot be read is no finished review', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fx.trust.seats = [];   // stands for review-brief.mjs that could not be loaded
  assert.match(item((await cmd(fx, 'ready')).out, 'review'), /^READY NOT DONE — review: the seats of a small change cannot be read/);
});

test('review: the PR text\'s suite line comes from the trusted reading, not from a receipt file in the notes folder', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  fs.mkdirSync(path.join(fx.notes, 'evidence', 'check-1'), { recursive: true });
  fs.writeFileSync(path.join(fx.notes, 'evidence', 'check-1', 'metadata.json'), JSON.stringify({ runId: 'r1', status: 'passed', executable: 'node', args: ['run', 'full-suite'], source: { treeBefore: fx.tree, treeAfter: fx.tree } }));
  fx.trust.runs = [startRun(fx), fullRun(fx)];   // the session shows no suite receipt
  assert.match((await cmd(fx, 'pr-body')).out, /^- Suite: NOT RUN on this tree$/m);
  fx.trust.runs = [startRun(fx), evidenceRun(fx), fullRun(fx)];
  assert.match((await cmd(fx, 'pr-body')).out, /^- Suite: passed on this tree$/m);
});

test('review: with the tests-only switch on, ready sizes the change once (the lane\'s sizing is reused)', async () => {
  const fx = fixture();
  await task(fx);
  allTrusted(fx);
  delete fx.trust.size;
  gitIn(fx.repo, 'config', 'sanad.testsOnlyLane', 'true');
  const { readFacts, trustedFacts } = await import('../scripts/sanad.mjs');
  process.env.SANAD_STATE_DIR = fx.state;
  const f = readFacts({ repo: fx.repo, notes: fx.notes, deep: true, sessionNotes: () => fx.notesList, trust: fx.trust });
  assert.ok(f.sizedNow && f.sizedNow.size, 'the lane sized the change');
  f.sizedNow = { ...f.sizedNow, size: 'medium' };   // a marker: trustedFacts reads this answer, it does not size again
  assert.equal((await trustedFacts(f)).live, 'medium');
});
