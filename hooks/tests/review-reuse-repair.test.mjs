import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runCommand} from '../../skills/gate/scripts/evidence.mjs';

// 2026-11-18, repair round on the review record (audit finding 2). THE PROMISE: `REVIEW: PASS — reused` is accepted only
// when (1) a completed independent review of the ORIGINAL commits is on record and (2) the pushed commits equal them.
// Each test below reproduces one confirmed finding (it fails on the first implementation) and the rule behind it:
//  1 the record is for the folder the reviewed change lives in, never the session folder by default
//  2 a later stop or push only ADDS a HEAD whose tree and base equal a record's; any other HEAD writes nothing
//  3 a squash of reviewed commits (same tree and base) is recorded, so the promotion of it is allowed
//  4 no record while a reviewer still runs; a FAIL or an open reviewer note withdraws the record
//  5 the old side of a range-diff is the WHOLE commit list of one record, not a part of it
//  6 an unrelated local change does not stop the record; a change to a file of the reviewed commits does
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = createRequire(import.meta.url)(path.join(hooks, 'lib', 'review-store.cjs'));

let n = 0;
const at = () => new Date(Date.UTC(2026, 10, 18, 6, 0, 0) + (++n) * 1000).toISOString();
const msg = (role, content, rest = {}) => ({type: role, message: {role, content}, timestamp: at(), ...rest});
const say = text => msg('assistant', [{type: 'text', text}]);
const call = (id, name, input) => msg('assistant', [{type: 'tool_use', id, name, input}]);
const result = (id, content, toolUseResult) => msg('user', [{type: 'tool_result', tool_use_id: id, content, is_error: false}], toolUseResult ? {toolUseResult} : {});
const launch = id => [
  call(id + '-call', 'Agent', {description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.', run_in_background: true}),
  result(id + '-call', 'Async agent launched successfully.', {isAsync: true, status: 'async_launched', agentId: id}),
];
const finish = (id, report) => ({type: 'attachment', timestamp: at(), attachment: {type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n<result>' + report + '</result>\n</task-notification>'}});
const reviewerRun = (id, report = 'RECOMMEND: PASS\nNo findings.') => [...launch(id), finish(id, report)];
const BLOCKER = 'RECOMMEND: FAIL\n\nFINDINGS (most severe first)\n\n1. Blocker — src/App.ts:3 — any user can read another tenant.\n   Fix: check the owner.\n';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-repair-'));
const stateDir = path.join(scratch, 'state');
process.env.SANAD_STATE_DIR = stateDir;
fs.mkdirSync(stateDir, {recursive: true});
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), '2026-01-01T00:00:00.000Z\n');
test.after(() => { delete process.env.SANAD_STATE_DIR; fs.rmSync(scratch, {recursive: true, force: true}); });

const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
const repoB = path.join(scratch, 'repoB'); fs.mkdirSync(repoB);
const worktree = path.join(scratch, 'wt');
const transcript = path.join(scratch, 'transcript.jsonl');
const gitIn = (cwd, args) => execFileSync('git', args, {cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000}).trim();
const git = args => gitIn(repo, args);
const records = () => store.load();
const clearRecords = () => fs.rmSync(path.join(stateDir, store.FILE), {force: true});
const ident = () => store.identity(repo);
const ident0 = ['config', 'user.name', 'developzone5'];
const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true}); fs.writeFileSync(path.join(repo, file), text); git(['add', '--', file]); };

git(['init', '--initial-branch=staging']); git(ident0); git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
put('README.md', 'Fixture.\n'); put('check.js', '0;\n'); git(['commit', '-m', 'test: baseline']);
const base0 = git(['rev-parse', 'HEAD']);
put('other.txt', 'x\n'); git(['commit', '-m', 'test: base moves']);
const base1 = git(['rev-parse', 'HEAD']);
git(['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
// U: a commit nobody reviewed, and U' its message-only amend
git(['switch', '-c', 'unrev', base0]); put('src/U.ts', 'u1\nu2\nu3\nu4\nu5\nu6\nu7\nu8\n'); git(['commit', '-m', 'feat: unreviewed']);
const U = git(['rev-parse', 'HEAD']);
git(['switch', '-c', 'unrev2', 'unrev']); git(['commit', '--amend', '-m', 'feat: unreviewed, reworded']);
const U2 = git(['rev-parse', 'HEAD']);
const rdU = `git range-diff ${base0}..${U} ${base0}..${U2}`;
const rdUOut = git(['range-diff', `${base0}..${U}`, `${base0}..${U2}`]);
// A: the reviewed commit of another branch (also checked out in a second worktree)
git(['switch', '-c', 'old', base0]); put('src/App.ts', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'); git(['commit', '-m', 'feat: a']);
const A = git(['rev-parse', 'HEAD']);
// a branch with new content on the same base (a hand amend with new lines)
git(['switch', '-c', 'content', 'old']); fs.appendFileSync(path.join(repo, 'src/App.ts'), 'l9\n'); git(['commit', '-a', '--amend', '-m', 'feat: a with a new line']);
const C = git(['rev-parse', 'HEAD']);
// two reviewed commits A2, B2, their squash S (same tree, same base) and the cherry-pick P of S on the moved base
git(['switch', '-c', 'two', base0]); put('src/two.ts', 'a1\na2\na3\na4\na5\na6\na7\na8\n'); git(['commit', '-m', 'feat: two a']);
const A2 = git(['rev-parse', 'HEAD']);
fs.appendFileSync(path.join(repo, 'src/two.ts'), 'b1\nb2\nb3\nb4\nb5\nb6\nb7\nb8\n'); git(['commit', '-a', '-m', 'fix: two b']);
const B2 = git(['rev-parse', 'HEAD']);
git(['switch', '-c', 'squash', 'two']); git(['reset', '--soft', base0]); git(['commit', '-m', 'feat: squashed']);
const S = git(['rev-parse', 'HEAD']);
git(['switch', '-c', 'squashmoved', base1]); git(['cherry-pick', S]);
const P = git(['rev-parse', 'HEAD']);
const rdS = `git range-diff ${base0}..${S} ${base1}..${P}`;
const rdSOut = git(['range-diff', `${base0}..${S}`, `${base1}..${P}`]);
// A2 alone, amended in its message only
git(['switch', '-c', 'partial', base0]); git(['cherry-pick', A2]); git(['commit', '--amend', '-m', 'feat: two a, reworded']);
const A2b = git(['rev-parse', 'HEAD']);
const rdPart = `git range-diff ${base0}..${A2} ${base0}..${A2b}`;
const rdPartOut = git(['range-diff', `${base0}..${A2}`, `${base0}..${A2b}`]);
git(['worktree', 'add', '-b', 'wtold', worktree, 'old']);
// a second repository, whose files the session edits
gitIn(repoB, ['init', '--initial-branch=main']); fs.mkdirSync(path.join(repoB, 'src')); fs.writeFileSync(path.join(repoB, 'src/b.js'), 'x\n');

const edit = (file = path.join(repo, 'src/App.ts'), id = 'ed') => [call(id, 'Edit', {file_path: file, old_string: 'a', new_string: 'b'}), result(id, 'ok')];
const bound = {};
const checkFor = async branch => {
  if (bound[branch]) return bound[branch];
  git(['switch', '-q', branch]);
  const check = await runCommand({executable: process.execPath, args: ['--check', 'check.js'], cwd: repo, outputRoot: path.join(scratch, 'checks-' + branch)});
  return bound[branch] = [call('bound', 'Bash', {command: 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'}), result('bound', 'CHECK_COMPLETED ' + JSON.stringify(check))];
};
const pushDecision = async (branch, entries) => {
  const head = await checkFor(branch);
  git(['switch', '-q', branch]);
  fs.writeFileSync(transcript, [...edit(), ...head, ...entries].map(JSON.stringify).join('\n'));
  const out = execFileSync(process.execPath, [path.join(hooks, 'policy-guard.js')], {cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
    input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, session_id: 'sess-1', transcript_path: transcript, tool_input: {command: 'git push origin HEAD:fix/probe'}})});
  return out ? JSON.parse(out).hookSpecificOutput : {permissionDecision: 'allow', permissionDecisionReason: ''};
};
const stop = (branch, entries, last, opts = {}) => {
  if (branch) git(['switch', '-q', branch]);
  fs.writeFileSync(transcript, [...(opts.edit === undefined ? edit() : opts.edit), ...entries].map(JSON.stringify).join('\n'));
  execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], {cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
    input: JSON.stringify({hook_event_name: 'Stop', cwd: repo, session_id: 'sess-1', transcript_path: transcript, last_assistant_message: last})});
};
const reused = (rd, out) => [call('rd', 'Bash', {command: rd}), result('rd', out), say('REVIEW: PASS — reused'), say('GATE: PASS')];
const recorded = hash => records().some(x => x.commits.includes(hash));
const reuseU = () => pushDecision('unrev2', reused(rdU, rdUOut));

test('finding 1: a review of another repository does not put the session folder\'s commits on record', async () => {
  clearRecords();
  stop('unrev', reviewerRun('rv-1'), 'Reviewed the change in repoB.\nREVIEW: PASS', {edit: edit(path.join(repoB, 'src/b.js'))});
  assert.equal(recorded(U), false, 'U was never reviewed');
  assert.deepEqual(records(), []);
  const d = await reuseU();
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no completed review is on record/);
});

test('finding 1: a session that touched no file records nothing; a review of another worktree records that worktree only', () => {
  clearRecords();
  const status = [call('st', 'Bash', {command: `git -C "${worktree}" status`}), result('st', 'On branch old')];
  stop('unrev', [...status, ...reviewerRun('rv-2')], 'REVIEW: PASS', {edit: []});
  assert.deepEqual(records(), [], 'no edit, no known folder: nothing');
  stop('unrev', reviewerRun('rv-3'), 'REVIEW: PASS', {edit: edit(path.join(worktree, 'src/App.ts'))});
  assert.equal(recorded(U), false, 'the session folder\'s commit is not recorded');
  assert.equal(recorded(A), true, 'the reviewed worktree is recorded');
});

test('finding 2: a HEAD that moved after the verdict writes nothing (gh pr checkout, a hand switch, a content amend)', async () => {
  clearRecords();
  stop('old', reviewerRun('rv-4'), 'REVIEW: PASS');
  assert.deepEqual(records().map(x => x.head), [A]);
  const pr = [...reviewerRun('rv-5'), say('REVIEW: PASS'), call('gh', 'Bash', {command: 'gh pr checkout 790'}), result('gh', 'Switched')];
  stop('unrev', pr, 'That PR adds Evil.ts.');                  // (a) HEAD is U now
  assert.equal(recorded(U), false, 'gh pr checkout');
  stop('unrev', [...reviewerRun('rv-6'), say('REVIEW: PASS')], 'Here is the answer to your question.');   // (b) switched by hand
  assert.equal(recorded(U), false, 'a hand switch');
  stop('content', [...reviewerRun('rv-7'), say('REVIEW: PASS')], 'Anything else?');                     // (c) new content on the same base
  assert.equal(recorded(C), false, 'an amend with new content');
  assert.deepEqual(records().map(x => x.head), [A], 'only the reviewed commit stays');
  assert.equal((await reuseU()).permissionDecision, 'deny');
});

test('finding 3: a squash of reviewed commits (same tree, same base) is recorded, and its promotion is allowed', async () => {
  clearRecords();
  stop('two', reviewerRun('rv-8'), 'REVIEW: PASS\nGATE: PASS');
  assert.deepEqual(records().map(x => x.commits), [[A2, B2]]);
  // the squash itself (reset --soft + commit) is a git change after the review: the strict verdict test no longer holds
  const squashMove = [call('sq0', 'Bash', {command: `git reset --soft ${base0} && git commit -m squashed`, cwd: repo}), result('sq0', 'ok')];
  stop('squash', [...reviewerRun('rv-8'), say('REVIEW: PASS'), ...squashMove], 'The squash is ready.');
  assert.deepEqual(records().map(x => x.commits), [[A2, B2], [S]], 'S added at the next stop');
  const d = await pushDecision('squashmoved', reused(rdS, rdSOut));
  assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.equal(recorded(P), false, 'a reused verdict never writes a record itself');
});

test('finding 3: the push guard records the squash it lets through as a normal review', async () => {
  clearRecords();
  stop('two', reviewerRun('rv-9'), 'REVIEW: PASS');
  const squashMove = [call('sq', 'Bash', {command: `git reset --soft ${base0} && git commit -m squashed`, cwd: repo}), result('sq', 'ok')];
  const d = await pushDecision('squash', [...squashMove, ...reviewerRun('rv-10'), say('REVIEW: PASS'), say('GATE: PASS')]);
  assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.equal(recorded(S), true);
});

test('finding 4: no record while a second reviewer still runs; a FAIL or an open note withdraws a record', async () => {
  clearRecords();
  stop('old', [...launch('rv-slow'), ...reviewerRun('rv-11'), say('REVIEW: PASS')], 'REVIEW: PASS');
  assert.deepEqual(records(), [], 'a reviewer launched after the change has not reported');
  // the record is made, then the second report brings a Blocker and the verdict turns FAIL
  stop('old', reviewerRun('rv-12'), 'REVIEW: PASS');
  assert.equal(recorded(A), true);
  stop('old', [...reviewerRun('rv-12'), ...reviewerRun('rv-13', BLOCKER)], 'REVIEW: FAIL — a Blocker is open');
  assert.equal(recorded(A), false, 'withdrawn');
  const amended = await pushDecision('amended', reused(`git range-diff ${base0}..${A} ${base0}..${amendedHead()}`, amendedOut()));
  assert.equal(amended.permissionDecision, 'deny');
  // an open note alone (no FAIL line) withdraws too
  stop('old', reviewerRun('rv-14'), 'REVIEW: PASS');
  assert.equal(recorded(A), true);
  stop('old', [...reviewerRun('rv-14'), ...reviewerRun('rv-15', BLOCKER)], 'Still working on it.');
  assert.equal(recorded(A), false);
});

let amendedCache = null;
function amendedHead() { return amendedInfo().head; }
function amendedOut() { return amendedInfo().out; }
function amendedInfo() {
  if (amendedCache) return amendedCache;
  git(['switch', '-q', '-c', 'amended', 'old']); git(['commit', '--amend', '-m', 'feat: a, reworded']);
  const head = git(['rev-parse', 'HEAD']);
  return amendedCache = {head, out: git(['range-diff', `${base0}..${A}`, `${base0}..${head}`])};
}

test('finding 5: a record of two commits does not vouch for one of them pushed alone', async () => {
  clearRecords();
  assert.equal(store.write(transcript, {repo: ident(), head: B2, commits: [A2, B2]}, 'sess-0'), true);
  const d = await pushDecision('partial', reused(rdPart, rdPartOut));
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no completed review is on record/);
  assert.equal(store.reviewed(transcript, repo, [A2.slice(0, 10)]).ok, false, 'a part of a record');
  assert.equal(store.reviewed(transcript, repo, [A2, B2]).ok, true, 'the whole list');
  assert.equal(store.reviewed(transcript, repo, [B2, A2]).ok, false, 'the same commits in another order');
  clearRecords();
  assert.equal(store.write(transcript, {repo: ident(), head: A2, commits: [A2]}, 'sess-0'), true);
  assert.equal((await pushDecision('partial', reused(rdPart, rdPartOut))).permissionDecision, 'allow', 'a record of exactly that commit');
});

test('finding 6: an unrelated local change does not stop the record; a change to a reviewed file does', () => {
  clearRecords();
  git(['switch', '-q', 'old']);
  fs.appendFileSync(path.join(repo, 'README.md'), 'local dev note\n');
  try { stop('old', reviewerRun('rv-16'), 'REVIEW: PASS'); } finally { git(['checkout', '--', 'README.md']); }
  assert.deepEqual(records().map(x => x.head), [A], 'README.md is not in base..HEAD');
  clearRecords();
  fs.appendFileSync(path.join(repo, 'src/App.ts'), 'dirty\n');
  try { stop('old', reviewerRun('rv-17'), 'REVIEW: PASS'); } finally { git(['checkout', '--', 'src/App.ts']); }
  assert.deepEqual(records(), [], 'src/App.ts is one of the reviewed files');
  clearRecords();
  put('src/App.ts', fs.readFileSync(path.join(repo, 'src/App.ts'), 'utf8') + 'staged\n');
  try { stop('old', reviewerRun('rv-18'), 'REVIEW: PASS'); } finally { git(['reset', '-q', '--', 'src/App.ts']); git(['checkout', '--', 'src/App.ts']); }
  assert.deepEqual(records(), [], 'a staged change to a reviewed file');
});

test('a reused verdict at a stop adds nothing, even when the tree equals a record', () => {
  clearRecords();
  store.write(transcript, {repo: ident(), head: U, commits: [U], tree: git(['rev-parse', U + '^{tree}']), base: base0}, 'sess-0');
  const before = JSON.stringify(records());
  stop('unrev2', [...reviewerRun('rv-19'), say('REVIEW: PASS — reused')], 'REVIEW: PASS — reused');
  assert.equal(JSON.stringify(records()), before);
  stop('unrev2', [...reviewerRun('rv-19'), say('REVIEW: PASS')], 'A plain stop.');
  assert.equal(recorded(U2), true, 'a normal standing verdict lets the message-only amend of a reviewed tree join');
});
