// push-lock.cjs (2026-11-25, owner batch x task 3): a git pre-push hook that asks the push guard about a push typed
// outside Claude. Real git, a real bare remote, the real hook process and the real policy-guard.js; the state folder,
// the home folder and the session roots are temp folders, so no real session or record is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = path.join(hooks, 'push-lock.cjs');
const msg = (role, content) => ({ type: role, message: { role, content } });
const say = (text) => msg('assistant', [{ type: 'text', text }]);
const call = (id, command) => msg('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
const result = (id, content) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: false }]);
let n = 0;
const reviewerRun = () => {
  const id = 'reviewer' + (++n);
  return [
    msg('assistant', [{ type: 'tool_use', id: id + '-call', name: 'Agent', input: { description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.' } }]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id + '-call', content: 'Async agent launched successfully.', is_error: false }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n</task-notification>' } },
  ];
};

function fixture(t) {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'push-lock-')));
  t.after(() => { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp */ } });
  const home = path.join(scratch, 'home'), state = path.join(scratch, 'state'), config = path.join(scratch, 'config');
  for (const d of [home, state, path.join(config, 'projects', 'p')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), CLAUDE_CONFIG_DIR: config, SANAD_STATE_DIR: state, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const remote = path.join(scratch, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  git('init', '-q', '--initial-branch=staging'); git('config', 'user.name', 'developzone5'); git('config', 'user.email', '65265330+developzone5@users.noreply.github.com'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Fixture only.\n'); git('add', '--', 'README.md'); git('commit', '-q', '-m', 'test: baseline');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'staging');
  git('fetch', '-q', 'origin');
  const commit = (branch, file, text = 'export const x = 1;\n') => {
    if (branch) git('switch', '-q', '-c', branch, 'origin/staging');
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text); git('add', '--', file); git('commit', '-q', '-m', 'test: change ' + file);
    return git('rev-parse', 'HEAD^{tree}');
  };
  const receipt = (tree) => {
    const id = 'rc' + (++n);
    const rec = { runId: crypto.randomUUID(), cwd: repo, executable: 'node', args: ['--test', 'spec' + n + '.json'], status: 'passed', nativeExitCode: 0, source: { toplevel: repo, treeBefore: tree, treeAfter: tree } };
    return [call(id, 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture' + n + '.json'), result(id, 'CHECK_COMPLETED ' + JSON.stringify(rec))];
  };
  const verdicts = () => [...reviewerRun(), say('REVIEW: PASS'), say('GATE: PASS')];
  const transcript = path.join(config, 'projects', 'p', 'session-1.jsonl');
  // The session names the repository's folder, as a real one does (its commands ran there).
  const session = (entries) => fs.writeFileSync(transcript, [say('Working in ' + repo), ...entries].map((e) => JSON.stringify(e)).join('\n'));
  // The review record, written by the guard's own module, for the commits HEAD holds now.
  const record = () => {
    const prev = process.env.SANAD_STATE_DIR;
    process.env.SANAD_STATE_DIR = state;
    try {
      const store = createRequire(import.meta.url)(path.join(hooks, 'lib', 'review-store.cjs'));
      assert.equal(store.write(transcript, store.snapshot(repo, store.defaultBase(repo)), 's'), true, 'the record is written');
    } finally { if (prev === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = prev; }
  };
  const node = (...args) => spawnSync(process.execPath, [lock, ...args], { cwd: repo, encoding: 'utf8', env, windowsHide: true });
  const push = (spec = 'HEAD:refs/heads/fix/probe') => spawnSync('git', ['push', 'origin', spec], { cwd: repo, encoding: 'utf8', env, windowsHide: true, timeout: 180000 });
  const remoteHas = (ref) => spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).status === 0;
  return { scratch, repo, remote, state, git, commit, receipt, verdicts, session, record, node, push, remoteHas, env };
}
const refusal = (r) => r.stderr.split(/\r?\n/).filter((l) => l.startsWith('PUSH LOCK:'));

test('install puts one hook in one repository; remove takes it out; another repository is never touched', (t) => {
  const f = fixture(t);
  const other = path.join(f.scratch, 'other');
  execFileSync('git', ['init', '-q', other]);
  const r = f.node('install', '--repo', f.repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PUSH LOCK: installed in .*\/hooks\/pre-push/);
  assert.match(r.stdout, /Limits: `git push --no-verify` skips it, and a core\.hooksPath set later turns it off\./);
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-push');
  assert.match(fs.readFileSync(hook, 'utf8'), /^#!\/bin\/sh\n# sanad-push-lock\n/);
  assert.ok(!fs.existsSync(path.join(other, '.git', 'hooks', 'pre-push')), 'a repository where it was never installed has no hook');
  assert.equal(f.node('install', '--repo', f.repo).status, 0, 'installing again rewrites its own hook');
  const rm = f.node('remove', '--repo', f.repo);
  assert.equal(rm.status, 0);
  assert.ok(!fs.existsSync(hook));
  assert.match(f.node('remove', '--repo', f.repo).stdout, /none in .*; nothing to remove/);
});

test('it never replaces another pre-push hook, and never writes into a core.hooksPath folder', (t) => {
  const f = fixture(t);
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  const r = f.node('install', '--repo', f.repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is another pre-push hook; nothing was changed/);
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.match(f.node('remove', '--repo', f.repo).stdout, /is another pre-push hook, not the push lock/);
  assert.ok(fs.existsSync(hook));
  fs.rmSync(hook);
  f.git('config', 'core.hooksPath', path.join(f.scratch, 'shared-hooks'));
  const shared = f.node('install', '--repo', f.repo);
  assert.equal(shared.status, 1);
  assert.match(shared.stdout, /reads its hooks from core\.hooksPath/);
  assert.ok(!fs.existsSync(path.join(f.scratch, 'shared-hooks', 'pre-push')));
});

test('the honest flow passes: a passing receipt of this tree, the reviewer run, both verdicts and the review record', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', 'src/App.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.record();
  assert.equal(f.node('install', '--repo', f.repo).status, 0);
  const r = f.push();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(f.remoteHas('refs/heads/fix/probe'));
});

test('no receipt: refused in one line that names what is missing and the command that makes it', (t) => {
  const f = fixture(t);
  f.commit('fix/probe', 'src/App.ts');
  f.session([...f.verdicts()]);
  f.record();
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.notEqual(r.status, 0);
  const lines = refusal(r);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^PUSH LOCK: refused — the push guard refuses it \(publishing requires a completed evidence\.mjs check of this repository and the exact outgoing tree/);
  assert.match(lines[0], /To make it pass: in a Claude session on this branch run `node ~\/\.claude\/skills\/gate\/scripts\/sanad\.mjs next --repo .*`/);
  assert.ok(!f.remoteHas('refs/heads/fix/probe'));
});

test('a receipt of another tree is refused', (t) => {
  const f = fixture(t);
  const older = f.commit('fix/probe', 'src/App.ts');
  f.commit(null, 'src/Other.ts');
  f.session([...f.receipt(older), ...f.verdicts()]);
  f.record();
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.notEqual(r.status, 0);
  assert.match(refusal(r)[0], /the push guard refuses it \(.*evidence\.mjs check of this repository and the exact outgoing tree/);
  assert.ok(!f.remoteHas('refs/heads/fix/probe'));
});

test('a review record of other commits is refused, before the guard is asked', (t) => {
  const f = fixture(t);
  f.commit('fix/probe', 'src/App.ts');
  f.record();                                   // the record of the first commit only
  const tree = f.commit(null, 'src/Other.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.notEqual(r.status, 0);
  assert.match(refusal(r)[0], /^PUSH LOCK: refused — no review record holds these 2 commit\(s\) \(HEAD [0-9a-f]{12}\)\. To make it pass: in a Claude session/);
  assert.ok(!f.remoteHas('refs/heads/fix/probe'));
});

test('a damaged review record file is a refusal, never a pass', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', 'src/App.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.record();
  fs.writeFileSync(path.join(f.state, 'review-records.json'), '{"records": [ {"repo": ');
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.notEqual(r.status, 0);
  assert.match(refusal(r)[0], /^PUSH LOCK: refused — the review record file .*review-records\.json cannot be read\./);
  assert.ok(!f.remoteHas('refs/heads/fix/probe'));
});

test('no Claude session (a Codex task, a terminal) is refused; a transcript the guard cannot read is refused', (t) => {
  const f = fixture(t);
  f.commit('fix/probe', 'src/App.ts');
  f.record();
  f.node('install', '--repo', f.repo);
  const none = f.push();
  assert.notEqual(none.status, 0);
  assert.match(refusal(none)[0], /no Claude session on this PC checked and reviewed this tree/);
  f.session([]);
  fs.appendFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'projects', 'p', 'session-1.jsonl'), '\n\u0000not json at all');
  const broken = f.push();
  assert.notEqual(broken.status, 0);
  assert.match(refusal(broken)[0], /^PUSH LOCK: refused — the push guard refuses it/);
  assert.ok(!f.remoteHas('refs/heads/fix/probe'));
});

test('what the guard would ask the human first is refused: a direct push to the integration branch, a force push', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', 'src/App.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.record();
  f.node('install', '--repo', f.repo);
  const direct = f.push('HEAD:refs/heads/staging');
  assert.notEqual(direct.status, 0);
  assert.match(refusal(direct)[0], /the push guard would ask the human first \(direct push to the integration branch `staging`/);
  // the same settings as the guard: a clone that names its own integration branch
  f.git('config', 'sanad.integration', 'trunk');
  const named = f.push('HEAD:refs/heads/trunk');
  assert.notEqual(named.status, 0);
  assert.match(refusal(named)[0], /direct push to the integration branch `trunk`/);
  f.git('config', '--unset', 'sanad.integration');
  assert.equal(f.push().status, 0, 'control: the feature branch goes out');
  f.git('commit', '-q', '--amend', '-m', 'test: reworded');
  const tree2 = f.git('rev-parse', 'HEAD^{tree}');
  f.session([...f.receipt(tree2), ...f.verdicts()]);
  f.record();
  const forced = spawnSync('git', ['push', '--force', 'origin', 'HEAD:refs/heads/fix/probe'], { cwd: f.repo, encoding: 'utf8', env: f.env, windowsHide: true, timeout: 180000 });
  assert.notEqual(forced.status, 0);
  assert.match(refusal(forced)[0], /would ask the human first \(force-push rewrites pushed history/);
  // Review round: a push from a Claude session runs this same hook, so the way out names the owner's own push.
  assert.doesNotMatch(refusal(forced)[0], /push from a Claude session/);
  assert.match(refusal(forced)[0], /the owner's own decision: the owner runs it by hand/);
});

test('a branch that is not checked out, a tag and a remote delete are refused (review round)', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', 'src/App.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.record();
  f.git('branch', 'other', 'origin/staging');
  f.git('tag', 'v1');
  f.node('install', '--repo', f.repo);
  assert.equal(f.push().status, 0, 'control');
  const other = f.push('other:refs/heads/other');
  assert.notEqual(other.status, 0);
  assert.match(refusal(other)[0], /^PUSH LOCK: refused — /);
  const tag = f.push('refs/tags/v1:refs/tags/v1');
  assert.notEqual(tag.status, 0);
  assert.match(refusal(tag)[0], /^PUSH LOCK: refused — /);
  const del = f.push(':refs/heads/fix/probe');
  assert.notEqual(del.status, 0);
  assert.match(refusal(del)[0], /would ask the human first/);
  assert.ok(f.remoteHas('refs/heads/fix/probe'), 'the remote branch is still there');
});

test('the newest session decides: an older pass does not outlive a newer session of the same repository (review round)', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', 'src/App.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.record();
  const newer = path.join(f.env.CLAUDE_CONFIG_DIR, 'projects', 'p', 'session-2.jsonl');
  fs.writeFileSync(newer, [say('Working in ' + f.repo), ...reviewerRun(), say('REVIEW: FAIL')].map((e) => JSON.stringify(e)).join('\n'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(newer, later, later);
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.notEqual(r.status, 0);
  assert.match(refusal(r)[0], /the push guard refuses it/);
  fs.rmSync(newer);
  assert.equal(f.push().status, 0, 'control: the session that checked this tree');
});

test('a review record whose commit list is damaged is no record of these commits (review round)', (t) => {
  const f = fixture(t);
  f.commit('fix/probe', 'src/App.ts');
  const tree = f.commit(null, 'src/Other.ts');
  f.session([...f.receipt(tree), ...f.verdicts()]);
  f.record();
  const file = path.join(f.state, 'review-records.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.records[0].commits = [data.records[0].commits.join(',')];
  fs.writeFileSync(file, JSON.stringify(data));
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.notEqual(r.status, 0);
  assert.match(refusal(r)[0], /no review record holds these 2 commit\(s\)/);
});

test('git\'s list of what is pushed that cannot be read is a refusal, never "nothing is pushed" (review round)', (t) => {
  const f = fixture(t);
  f.commit('fix/probe', 'src/App.ts');
  const req = createRequire(import.meta.url);
  const lockModule = req(lock);
  const nfs = req('fs');
  const real = nfs.readFileSync;
  const cwd = process.cwd();
  const err = [];
  const write = process.stderr.write;
  process.chdir(f.repo);
  nfs.readFileSync = (file, ...rest) => { if (file === 0) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }); return real(file, ...rest); };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  let code;
  try { code = lockModule.main(['check', 'origin']); } finally { nfs.readFileSync = real; process.stderr.write = write; process.chdir(cwd); }
  assert.equal(code, 1);
  assert.match(err.join(''), /^PUSH LOCK: refused — git's list of what is pushed could not be read \(EAGAIN\)/);
});

test('the workflow lane is read as the guard reads it: no reviewer and no review record, but the receipt and the gate stay', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', 'hooks/guard.js', 'module.exports = 1;\n');
  f.git('config', 'sanad.lane', 'workflow');
  f.session([...f.receipt(tree), say('GATE: PASS')]);
  f.node('install', '--repo', f.repo);
  const r = f.push();
  assert.equal(r.status, 0, r.stderr);
  f.commit(null, 'hooks/other.js', 'module.exports = 2;\n');
  const stale = f.push();
  assert.notEqual(stale.status, 0, 'the receipt is of the old tree');
});
