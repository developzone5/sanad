import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runCommand} from '../../skills/gate/scripts/evidence.mjs';

// 2026-11-18, audit finding 2 (High): `REVIEW: PASS — reused` was accepted on equal patches alone. An unreviewed commit
// amended only in its message shows equal code in a real range-diff, so a "reused" verdict passed with
// lastReviewerRun -1. THE PROMISE: a reused verdict is accepted only when (1) a completed independent review of the
// ORIGINAL commits is on record (lib/review-store.cjs) and (2) the pushed commits equal those commits.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = createRequire(import.meta.url)(path.join(hooks, 'lib', 'review-store.cjs'));

let n = 0;
const at = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0) + (++n) * 1000).toISOString();
const msg = (role, content, rest = {}) => ({type: role, message: {role, content}, timestamp: at(), ...rest});
const say = text => msg('assistant', [{type: 'text', text}]);
const call = (id, name, input) => msg('assistant', [{type: 'tool_use', id, name, input}]);
const result = (id, content, toolUseResult) => msg('user', [{type: 'tool_result', tool_use_id: id, content, is_error: false}], toolUseResult ? {toolUseResult} : {});
const reviewerRun = (id, report = 'RECOMMEND: PASS\nNo findings.') => [
  call(id + '-call', 'Agent', {description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.', run_in_background: true}),
  result(id + '-call', 'Async agent launched successfully.', {isAsync: true, status: 'async_launched', agentId: id}),
  {type: 'attachment', timestamp: at(), attachment: {type: 'queued_command', commandMode: 'task-notification',
    prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n<result>' + report + '</result>\n</task-notification>'}},
];
const NOTE_REPORT = 'RECOMMEND: FAIL\n\nFINDINGS (most severe first)\n\n1. Gap — src/App.ts:3 — a missing check.\n   Fix: add it.\n';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-record-'));
const stateDir = path.join(scratch, 'state');
process.env.SANAD_STATE_DIR = stateDir;
fs.mkdirSync(stateDir, {recursive: true});
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), '2026-01-01T00:00:00.000Z\n');
test.after(() => { delete process.env.SANAD_STATE_DIR; fs.rmSync(scratch, {recursive: true, force: true}); });

const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
const transcript = path.join(scratch, 'transcript.jsonl');
const git = args => execFileSync('git', args, {cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000}).trim();
const records = () => store.load();
const clearRecords = () => fs.rmSync(path.join(stateDir, store.FILE), {force: true});
const ident = () => store.identity(repo);

git(['init', '--initial-branch=staging']); git(['config', 'user.name', 'developzone5']); git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
fs.writeFileSync(path.join(repo, 'README.md'), 'Fixture.\n'); git(['add', '--', 'README.md']); git(['commit', '-m', 'test: baseline']);
const base0 = git(['rev-parse', 'HEAD']);
fs.writeFileSync(path.join(repo, 'other.txt'), 'x\n'); git(['add', '--', 'other.txt']); git(['commit', '-m', 'test: base moves']);
const base1 = git(['rev-parse', 'HEAD']);
git(['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
git(['switch', '-c', 'old', base0]);
fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/App.ts'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'); git(['add', '--', 'src/App.ts']); git(['commit', '-m', 'feat: a']);
const oldHead = git(['rev-parse', 'HEAD']);
// the reproduced case: the same commit amended only in its message
git(['switch', '-c', 'amended', 'old']); git(['commit', '--amend', '-m', 'feat: a, reworded']);
const amendedHead = git(['rev-parse', 'HEAD']);
const amendedOut = git(['range-diff', `${base0}..${oldHead}`, `${base0}..${amendedHead}`]);
// a clean cherry-pick of the same commit onto a moved base
git(['switch', '-c', 'moved', base1]); git(['cherry-pick', oldHead]);
const movedHead = git(['rev-parse', 'HEAD']);
const movedOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..${movedHead}`]);
assert.match(amendedOut, /!|=/); assert.match(movedOut, /=/);

// 2026-11-18 (repair round): a record is made only for the folder the reviewed change lives in, so the session
// edits a file of the fixture repository first (the earlier tests had no edit and recorded the session folder).
const edit = (file = path.join(repo, 'src/App.ts'), id = 'ed') => [call(id, 'Edit', {file_path: file, old_string: 'a', new_string: 'b'}), result(id, 'ok')];
const bound = {};
const checkFor = async branch => {
  if (bound[branch]) return bound[branch];
  git(['switch', '-q', branch]);
  const check = await runCommand({executable: process.execPath, args: ['--check', 'src/App.ts'], cwd: repo, outputRoot: path.join(scratch, 'checks-' + branch)});
  return bound[branch] = [call('bound', 'Bash', {command: 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'}), result('bound', 'CHECK_COMPLETED ' + JSON.stringify(check))];
};
const pushDecision = async (branch, entries, opts = {}) => {
  const head = await checkFor(branch);
  git(['switch', '-q', branch]);
  fs.writeFileSync(transcript, [...(opts.edit === undefined ? edit() : opts.edit), ...head, ...entries].map(JSON.stringify).join('\n'));
  const out = execFileSync(process.execPath, [path.join(hooks, 'policy-guard.js')], {cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
    input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, session_id: 'sess-1', transcript_path: transcript, tool_input: {command: 'git push origin HEAD:fix/probe'}})});
  return out ? JSON.parse(out).hookSpecificOutput : {permissionDecision: 'allow', permissionDecisionReason: ''};
};
const stop = (branch, entries, last, opts = {}) => {
  git(['switch', '-q', branch]);
  fs.writeFileSync(transcript, [...(opts.edit === undefined ? edit() : opts.edit), ...entries].map(JSON.stringify).join('\n'));
  execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], {cwd: opts.cwd || repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
    input: JSON.stringify({hook_event_name: 'Stop', cwd: opts.cwd || repo, session_id: 'sess-1', transcript_path: transcript, last_assistant_message: last})});
};
const reusedEntries = (rd, out) => [call('rd', 'Bash', {command: rd}), result('rd', out), say('REVIEW: PASS — reused'), say('GATE: PASS')];
const rdAmended = `git range-diff ${base0}..${oldHead} ${base0}..${amendedHead}`;
const rdMoved = `git range-diff ${base0}..${oldHead} ${base1}..${movedHead}`;

test('the reproduced case: an unreviewed commit amended in its message only is denied as "reused"', async () => {
  clearRecords();
  const d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no completed review is on record for/);
  assert.match(d.permissionDecisionReason, /without "reused"/);
  assert.deepEqual(records(), [], 'a denied reuse writes nothing');
});

test('a recorded review of the old commits plus an equal range-diff is allowed (amend and cherry-pick)', async () => {
  clearRecords();
  assert.equal(store.write(transcript, {repo: ident(), head: oldHead, commits: [oldHead]}, 'sess-0'), true);
  for (const [branch, rd, out] of [['amended', rdAmended, amendedOut], ['moved', rdMoved, movedOut]]) {
    const d = await pushDecision(branch, reusedEntries(rd, out));
    assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  }
});

test('a reused verdict never writes a record itself', async () => {
  clearRecords();
  store.write(transcript, {repo: ident(), head: oldHead, commits: [oldHead]}, 'sess-0');
  const before = JSON.stringify(records());
  const d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.equal(JSON.stringify(records()), before, 'the push guard added nothing');
  assert.equal(records().some(x => x.commits.includes(amendedHead)), false);
  // the stop gate, with a "reused" verdict as the final text and a reviewer run in the session, writes nothing either
  stop('amended', [...reviewerRun('rv-x'), say('REVIEW: PASS — reused')], 'REVIEW: PASS — reused');
  assert.equal(JSON.stringify(records()), before, 'the stop gate added nothing');
});

test('a record of another repository, or of other commits, does not count', async () => {
  clearRecords();
  store.write(transcript, {repo: 'url:github.com/other/project', head: oldHead, commits: [oldHead]}, 'sess-0');
  let d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'deny', 'same commits, other repository');
  assert.match(d.permissionDecisionReason, /no completed review is on record/);
  clearRecords();
  store.write(transcript, {repo: ident(), head: base1, commits: [base1]}, 'sess-0');
  d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'deny', 'same repository, other commits');
  // a record that holds only part of the old range does not cover the whole old range
  clearRecords();
  store.write(transcript, {repo: ident(), head: amendedHead, commits: [amendedHead]}, 'sess-0');
  d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'deny', 'the NEW commit on record does not vouch for the old one');
});

test('a corrupt or unreadable record file counts as no record', async () => {
  clearRecords();
  fs.writeFileSync(path.join(stateDir, store.FILE), '{not json');
  const d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'deny');
  clearRecords();
});

test('the push guard records a normal review and a later reuse rests on it', async () => {
  clearRecords();
  const normal = [...reviewerRun('rv-1'), say('REVIEW: PASS'), say('GATE: PASS')];
  let d = await pushDecision('old', normal);
  assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.equal(records().length, 1);
  assert.deepEqual(records()[0].commits, [oldHead]);
  assert.equal(records()[0].head, oldHead);
  assert.equal(records()[0].repo, ident());
  assert.equal(records()[0].session, 'sess-1');
  assert.ok(Date.parse(records()[0].at) > 0);
  d = await pushDecision('amended', reusedEntries(rdAmended, amendedOut));
  assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  // the same push twice: still one record
  await pushDecision('old', normal);
  assert.equal(records().length, 1, 'writing twice is harmless');
});

test('a denied push writes no record', async () => {
  clearRecords();
  // a verdict with no reviewer run is denied and must leave nothing behind
  const d = await pushDecision('old', [say('REVIEW: PASS'), say('GATE: PASS')]);
  assert.equal(d.permissionDecision, 'deny');
  assert.deepEqual(records(), []);
});

test('the stop gate records a normal review verdict from the final message', () => {
  clearRecords();
  stop('old', reviewerRun('rv-2'), 'Done.\nREVIEW: PASS\nGATE: PASS');
  assert.equal(records().length, 1);
  assert.deepEqual(records()[0].commits, [oldHead]);
  stop('old', reviewerRun('rv-2'), 'Done.\nREVIEW: PASS\nGATE: PASS');
  assert.equal(records().length, 1, 'a second stop writes nothing new');
});

// Repair round (finding 2): a verdict that only stands in the transcript is not a new snapshot of HEAD; HEAD may have
// moved since (gh pr checkout, a hand switch), so a record is made only at the stop that holds the verdict itself.
test('a stop whose final message holds no verdict makes no new record, even when the transcript has one', () => {
  clearRecords();
  stop('old', [...reviewerRun('rv-3'), say('REVIEW: PASS')], 'Anything else.');
  assert.deepEqual(records(), []);
});

test('the stop gate records nothing without a completed reviewer run, with a FAIL, a "reused" line, an open note or a dirty tree', () => {
  clearRecords();
  stop('old', [say('REVIEW: PASS')], 'REVIEW: PASS');
  assert.deepEqual(records(), [], 'no reviewer run');
  stop('old', reviewerRun('rv-4'), 'REVIEW: FAIL — a bug');
  assert.deepEqual(records(), [], 'a FAIL verdict');
  stop('old', reviewerRun('rv-4'), 'REVIEW: PASS — reused');
  assert.deepEqual(records(), [], 'a reused verdict');
  stop('old', reviewerRun('rv-5', NOTE_REPORT), 'REVIEW: PASS');
  assert.deepEqual(records(), [], 'an open reviewer note');
  stop('old', reviewerRun('rv-6'), 'Just a question for you.');
  assert.deepEqual(records(), [], 'no verdict at all');
  fs.appendFileSync(path.join(repo, 'src/App.ts'), 'dirty\n');
  try { stop('old', reviewerRun('rv-7'), 'REVIEW: PASS'); } finally { git(['checkout', '--', 'src/App.ts']); }
  assert.deepEqual(records(), [], 'a changed tracked file: the review may not cover the commits');
});

test('the stop gate writes nothing for a transcript that may not use the state folder', () => {
  clearRecords();
  const saved = process.env.SANAD_STATE_DIR;
  delete process.env.SANAD_STATE_DIR;
  try {
    git(['switch', '-q', 'old']);
    fs.writeFileSync(transcript, reviewerRun('rv-8').map(JSON.stringify).join('\n'));
    const env = {...process.env}; delete env.SANAD_STATE_DIR;
    execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], {cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 20000,
      input: JSON.stringify({hook_event_name: 'Stop', cwd: repo, session_id: 's', transcript_path: transcript, last_assistant_message: 'REVIEW: PASS'})});
  } finally { process.env.SANAD_STATE_DIR = saved; }
  assert.deepEqual(records(), []);
});

test('the whole way: the stop gate records the review, a message-only amend is reused, and without the stop it is denied', async () => {
  clearRecords();
  assert.equal((await pushDecision('amended', reusedEntries(rdAmended, amendedOut))).permissionDecision, 'deny');
  stop('old', reviewerRun('rv-9'), 'REVIEW: PASS\nGATE: PASS');
  assert.equal((await pushDecision('amended', reusedEntries(rdAmended, amendedOut))).permissionDecision, 'allow');
});

test('review-store: one spelling for one remote, and the folder when there is none', () => {
  const u = store.uniformUrl;
  assert.equal(u('https://github.com/Org/Repo.git'), 'github.com/org/repo');
  assert.equal(u('git@github.com:Org/Repo.git'), 'github.com/org/repo');
  assert.equal(u('https://user:token@github.com/org/repo/'), 'github.com/org/repo');
  assert.equal(u('ssh://git@github.com/org/repo.git'), 'github.com/org/repo');
  assert.notEqual(u('https://github.com/org/repo'), u('https://github.com/org/other'));
  assert.match(ident(), /^dir:/, 'this fixture has no origin');
  git(['config', 'remote.origin.url', 'git@github.com:Org/Repo.git']);
  try { assert.equal(ident(), 'url:github.com/org/repo'); } finally { git(['config', '--unset', 'remote.origin.url']); }
});
