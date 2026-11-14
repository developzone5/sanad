import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-14: `git switch -q main && git pull -q` in a clean clone (nothing edited) made the stop gate ask
// for a build. A switch, pull, merge, reset or checkout that leaves its folder clean with HEAD's tree equal
// to a remote branch tip's tree only shows upstream code: no change of this session's own. Real git repos,
// the real stop-gate.js in a child process; state in a temp folder, never the live ~/.claude/state.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-remote-tip-')));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });
// The user's global git config (hooks, templates, signing) stays out of these repos.
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
const env = {
  ...process.env, SANAD_STATE_DIR: stateDir, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const commit = (cwd, file, text, message) => { write(path.join(cwd, file), text); git(cwd, 'add', '--', file); git(cwd, 'commit', '-q', '-m', message); };

// A remote with main and feature, a seed clone that can push more, and the clone under test (on main).
let cases = 0;
function setup() {
  const dir = path.join(root, 'case' + (++cases));
  const remote = path.join(dir, 'remote.git'), seed = path.join(dir, 'seed'), clone = path.join(dir, 'clone');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(dir, 'clone', '-q', remote, seed);
  git(seed, 'switch', '-q', '-c', 'main');
  commit(seed, 'src/App.cs', 'class App {}\n', 'first');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'switch', '-q', '-c', 'feature');
  commit(seed, 'src/Feature.cs', 'class Feature {}\n', 'feature');
  git(seed, 'push', '-q', '-u', 'origin', 'feature');
  git(seed, 'switch', '-q', 'main');
  git(dir, 'clone', '-q', remote, clone);
  return { dir, remote, seed, clone };
}
// Someone else pushes a new commit to main: the clone's origin/main is behind until it fetches.
const advanceRemoteMain = (c, file = 'src/Upstream.cs') => { commit(c.seed, file, 'class Upstream {}\n', 'upstream'); git(c.seed, 'push', '-q', 'origin', 'main'); };
const treeOf = (cwd, rev) => git(cwd, 'rev-parse', rev + '^{tree}');
const remoteTips = (cwd) => git(cwd, 'for-each-ref', '--format=%(tree)', 'refs/remotes').split(/\r?\n/);

// The session's transcript: shell calls with the folder they ran in.
let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 14, 6, 0, 0) + (++seq) * 1000).toISOString();
const shell = (command, cwd, output = '') => {
  const id = 'b' + (++seq);
  return [
    { type: 'assistant', cwd, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', cwd, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }] } },
  ];
};
const edit = (file, cwd) => {
  const id = 'e' + (++seq);
  return [
    { type: 'assistant', cwd, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }] } },
    { type: 'user', cwd, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File updated.', is_error: false }] } },
  ];
};
const passingTest = (cwd) => shell('dotnet test', cwd, 'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3');

let runs = 0;
function stop(entries, cwd) {
  const file = path.join(root, 'transcript-' + (++runs) + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  const out = execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'remote-tip-' + runs, transcript_path: file, cwd }),
    env, cwd, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  const output = out.trim() ? JSON.parse(out) : {};
  return { decision: output.decision || 'allow', output };
}
const GIT_CHANGE_BLOCK = /no build\/test has run since the last edit/;

test('the real case: switch to main and pull in a clean clone is no code change', () => {
  const c = setup();
  git(c.clone, 'switch', '-q', 'feature');
  advanceRemoteMain(c);
  // What the session ran, for real.
  git(c.clone, 'switch', '-q', 'main');
  git(c.clone, 'pull', '-q');
  assert.equal(git(c.clone, 'status', '--porcelain'), '', 'precondition: the clone is clean');
  assert.equal(treeOf(c.clone, 'HEAD'), treeOf(c.seed, 'HEAD'), 'precondition: HEAD is the new upstream main');
  const r = stop(shell('git switch -q main && git pull -q', c.clone), c.clone);
  assert.equal(r.decision, 'allow', JSON.stringify(r.output));
});

test('a reset, a checkout and an fast-forward merge to a remote tip are no code change either', () => {
  const c = setup();
  advanceRemoteMain(c);
  git(c.clone, 'fetch', '-q');
  git(c.clone, 'reset', '-q', '--hard', 'origin/main');
  assert.equal(stop(shell('git fetch -q && git reset -q --hard origin/main', c.clone), c.clone).decision, 'allow', 'reset');
  git(c.clone, 'checkout', '-q', 'feature');
  assert.equal(stop(shell('git checkout -q feature', c.clone), c.clone).decision, 'allow', 'checkout of a branch at its remote tip');
  git(c.clone, 'checkout', '-q', 'main');
  advanceRemoteMain(c, 'src/Second.cs');
  git(c.clone, 'fetch', '-q');
  git(c.clone, 'merge', '-q', '--ff-only', 'origin/main');
  assert.equal(stop(shell('git checkout -q main && git merge -q --ff-only origin/main', c.clone), c.clone).decision, 'allow', 'fast-forward merge');
});

test('a switch to a local-only branch is still a change', () => {
  const c = setup();
  git(c.clone, 'switch', '-q', '-c', 'local-only');
  commit(c.clone, 'src/Local.cs', 'class Local {}\n', 'local work');
  git(c.clone, 'switch', '-q', 'main');
  git(c.clone, 'switch', '-q', 'local-only');
  assert.equal(git(c.clone, 'status', '--porcelain'), '', 'precondition: the clone is clean');
  assert.ok(!remoteTips(c.clone).includes(treeOf(c.clone, 'HEAD')), 'precondition: no remote tip has this tree');
  const r = stop(shell('git switch -q local-only', c.clone), c.clone);
  assert.equal(r.decision, 'block');
  assert.match(r.output.reason, GIT_CHANGE_BLOCK);
});

test('a pull that leaves a merge commit (local commits on top) is still a change', () => {
  const c = setup();
  git(c.clone, 'config', 'pull.rebase', 'false');
  commit(c.clone, 'src/Local.cs', 'class Local {}\n', 'local work');
  advanceRemoteMain(c);
  git(c.clone, 'pull', '-q', '--no-edit');
  assert.ok(git(c.clone, 'rev-parse', '--verify', '-q', 'HEAD^2'), 'precondition: HEAD is a merge commit');
  assert.equal(git(c.clone, 'status', '--porcelain'), '', 'precondition: the clone is clean');
  assert.ok(!remoteTips(c.clone).includes(treeOf(c.clone, 'HEAD')), 'precondition: no remote tip has this tree');
  const r = stop(shell('git pull -q --no-edit', c.clone), c.clone);
  assert.equal(r.decision, 'block');
  assert.match(r.output.reason, GIT_CHANGE_BLOCK);
});

test('a dirty or untracked file after the switch is still a change', () => {
  const c = setup();
  git(c.clone, 'switch', '-q', 'feature');
  write(path.join(c.clone, 'src/App.cs'), 'class App { int x; }\n');   // carried over by the switch
  git(c.clone, 'switch', '-q', 'main');
  assert.notEqual(git(c.clone, 'status', '--porcelain'), '', 'precondition: the clone is dirty');
  assert.equal(stop(shell('git switch -q main', c.clone), c.clone).decision, 'block', 'a modified tracked file');
  git(c.clone, 'checkout', '-q', '--', 'src/App.cs');
  write(path.join(c.clone, 'src/New.cs'), 'class New {}\n');
  assert.equal(stop(shell('git switch -q main', c.clone), c.clone).decision, 'block', 'an untracked, not ignored file');
});

test('earlier edits stay owed; a later check or a forbidden git form keeps the old rule', () => {
  const c = setup();
  git(c.clone, 'switch', '-q', 'main');
  const code = 'C:/repos/example/src/App.cs';   // edits touch no disk; a temp-folder path is exempt on Linux (/tmp)
  const sync = shell('git switch -q main && git pull -q', c.clone);
  assert.equal(stop([...edit(code, c.clone), ...sync], c.clone).decision, 'block', 'an earlier unverified edit is still owed');
  assert.equal(stop([...edit(code, c.clone), ...passingTest(c.clone), ...sync], c.clone).decision, 'allow', 'an edit checked before the sync');
  assert.equal(stop([...sync, ...edit(code, c.clone)], c.clone).decision, 'block', 'an edit after the sync');
  // git -c, GIT_* variables and a stash pop can move or change the code elsewhere: they stay changes.
  for (const cmd of ['git -c core.worktree=../seed pull -q', 'GIT_DIR=../seed/.git git pull -q',
    'export GIT_DIR=../seed/.git && git pull -q', '$env:GIT_WORK_TREE = "../seed"; git checkout -q main', 'git -C . -C ../seed pull -q', 'git stash pop', 'git rebase origin/main']) {
    assert.equal(stop(shell(cmd, c.clone), c.clone).decision, 'block', cmd);
  }
});

test('every folder a sync touched must be at a remote tip; relative folders are judged where they are', () => {
  const c = setup();
  const other = setup();
  git(other.clone, 'switch', '-q', '-c', 'local-only');
  commit(other.clone, 'src/Local.cs', 'class Local {}\n', 'local work');
  const both = [...shell('git switch -q main', c.clone), ...shell('git -C "' + other.clone.replace(/\\/g, '/') + '" switch -q local-only', c.clone)];
  assert.equal(stop(both, c.clone).decision, 'block', 'the second folder is on a local-only branch');
  // A relative -C and a relative cd land in the folder of the command, not the hook's folder.
  assert.equal(stop(shell('git -C clone switch -q main', c.dir), hooks).decision, 'allow', 'relative -C');
  assert.equal(stop(shell('cd clone && git pull -q', c.dir), hooks).decision, 'allow', 'relative cd');
  assert.equal(stop(shell('cd clone && cd ../../' + path.basename(other.dir) + '/clone && git pull -q', c.dir), hooks).decision, 'block', 'a chain of cds ends in the other clone');
  // `cd -` goes back to the folder before: never a folder named "-" (here an empty one in the clean clone).
  fs.mkdirSync(path.join(c.clone, '-'));
  const back = 'cd "' + other.clone.replace(/\\/g, '/') + '" && cd "' + c.clone.replace(/\\/g, '/') + '" && cd - && git switch -q local-only';
  assert.equal(stop(shell(back, c.dir), hooks).decision, 'block', 'cd - back to the local-only clone');
});

test('Git Bash on Windows: a /c/… folder is the C:/… folder', { skip: process.platform !== 'win32' }, () => {
  const c = setup();
  const bash = c.clone.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase());
  assert.equal(stop(shell('cd ' + bash + ' && git pull -q', hooks), hooks).decision, 'allow', 'absolute /c/ path');
});

// A helper agent's transcript sits next to the session's: <transcript>/subagents/agent-*.jsonl.
function stopWithHelper(sessionEntries, helperEntries, cwd) {
  const file = path.join(root, 'transcript-' + (++runs) + '.jsonl');
  fs.writeFileSync(file, sessionEntries.map((e) => JSON.stringify(e) + '\n').join(''));
  const helpers = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(helpers, 'agent-a1.jsonl'), helperEntries.map((e) => JSON.stringify(e) + '\n').join(''));
  const out = execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'remote-tip-' + runs, transcript_path: file, cwd }),
    env, cwd, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  const output = out.trim() ? JSON.parse(out) : {};
  return output.decision || 'allow';
}

test("a helper agent's sync is judged the same way; its edit stays a change", () => {
  const c = setup();
  const code = 'C:/repos/example/src/App.cs';
  const note = () => ({ type: 'assistant', cwd: c.clone, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  const helperSync = shell('git switch -q main && git pull -q', c.clone);
  assert.equal(stopWithHelper([note()], helperSync, c.clone), 'allow', "the helper's sync");
  const helperEditThenSync = [...edit(code, c.clone), ...shell('git pull -q', c.clone)];
  assert.equal(stopWithHelper([note()], helperEditThenSync, c.clone), 'block', "the helper's edit before its sync");
});
