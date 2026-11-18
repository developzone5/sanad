import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-17: the stop gate still said "Code files were edited this session (last change: a git
// merge/reset/switch/stash) but no build/test has run since the last edit" after a plain switch to main and
// a pull in ANOTHER repository (the session's own folder was a different one). The session's records show
// three causes, none of them the folder or the command's shape:
//  1. the sync is judged by its folder at the stop, and a prose file edited later (README.md) made that
//     folder dirty, so the earlier switch read as a change;
//  2. words like "git pull" inside the quoted text of a text tool (`sed -i 's/… then PC 2 git pull + …/'`
//     on a notes file) counted as a git change of their own, in the session's folder;
//  3. when the sync was credited and an earlier edit was still owed, the message still blamed the git change.
// Real git repos, the real stop-gate.js in a child process; state in a temp folder, never ~/.claude/state.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scan = createRequire(import.meta.url)(path.join(hooks, 'lib', 'transcript-scan.js'));
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-switch-other-')));
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

// A remote with main and feature, a seed clone that can push more, the clone the commands run in (on
// feature, with main one commit behind the remote), and the session's own folder: another repository.
let cases = 0;
function setup() {
  const dir = path.join(root, 'case' + (++cases));
  const remote = path.join(dir, 'remote.git'), seed = path.join(dir, 'seed'), clone = path.join(dir, 'clone'), session = path.join(dir, 'session');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(dir, 'clone', '-q', remote, seed);
  git(seed, 'switch', '-q', '-c', 'main');
  write(path.join(seed, 'README.md'), '# Example\n');
  git(seed, 'add', '--', 'README.md');
  commit(seed, 'src/App.cs', 'class App {}\n', 'first');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'switch', '-q', '-c', 'feature');
  commit(seed, 'src/Feature.cs', 'class Feature {}\n', 'feature');
  git(seed, 'push', '-q', '-u', 'origin', 'feature');
  git(seed, 'switch', '-q', 'main');
  git(dir, 'clone', '-q', remote, clone);
  git(clone, 'switch', '-q', 'feature');
  commit(seed, 'src/Upstream.cs', 'class Upstream {}\n', 'upstream');
  git(seed, 'push', '-q', 'origin', 'main');
  git(dir, 'init', '-q', '--initial-branch=main', session);
  commit(session, 'app/Program.cs', 'class Program {}\n', 'the session project');
  return { dir, remote, seed, clone, session };
}
const treeOf = (cwd, rev) => git(cwd, 'rev-parse', rev + '^{tree}');
const remoteTips = (cwd) => git(cwd, 'for-each-ref', '--format=%(tree)', 'refs/remotes').split(/\r?\n/);
// The folder as the Bash tool names it: Git Bash on Windows spells C:/ as /c/.
const bashPath = (p) => process.platform === 'win32' ? p.split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()) : p;
// What the session ran, for real: main is pulled to the remote tip; with a name, a new branch starts there.
function syncForReal(c, branch) {
  git(c.clone, 'switch', '-q', 'main');
  git(c.clone, 'pull', '-q');
  if (branch) git(c.clone, 'switch', '-q', '-c', branch);
  assert.equal(git(c.clone, 'status', '--porcelain'), '', 'precondition: the clone is clean');
  assert.ok(remoteTips(c.clone).includes(treeOf(c.clone, 'HEAD')), 'precondition: HEAD has the tree of a remote tip');
}

// The session's transcript: every call runs from the session's own folder.
let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 17, 6, 0, 0) + (++seq) * 1000).toISOString();
const shell = (command, cwd, output = '', tool = 'Bash') => {
  const id = 'b' + (++seq);
  return [
    { type: 'assistant', cwd, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: { command } }] } },
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
const passingTest = (c, file) => shell('cd "' + bashPath(c.clone) + '/hooks/tests" && node --test ' + file, c.session, '✔ it works (1.2ms)\nℹ tests 3\nℹ pass 3\nℹ fail 0\n');

let runs = 0;
function stop(entries, cwd, childEnv = env) {
  const file = path.join(root, 'transcript-' + (++runs) + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  const out = execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'switch-other-' + runs, transcript_path: file, cwd }),
    env: childEnv, cwd, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  const output = out.trim() ? JSON.parse(out) : {};
  return { decision: output.decision || 'allow', output };
}
const BLAMES_GIT = /last change: a git merge\/reset\/switch\/stash/;
const NO_CHECK = /no build\/test has run since the last edit/;
const gitChange = (seg) => scan.segmentEditPaths(seg).some((p) => p.startsWith('<git'));

test('case 1: switch to main, pull and log in another repository is no change (pins the 2026-11-14 rule)', () => {
  const c = setup();
  syncForReal(c);
  const cd = 'cd "' + bashPath(c.clone) + '"';
  for (const cmd of [
    cd + ' && git switch -q main && git pull -q && git log --oneline -1',
    cd + ' && git status --short | head -3; git switch -q main && git pull -q && git log --oneline -1',
    'S="' + bashPath(c.clone) + '"\ncd $S && git switch -q main && git pull -q && git log --oneline -1',
  ]) {
    const r = stop(shell(cmd, c.session, 'fc096c2 upstream'), c.session);
    assert.equal(r.decision, 'allow', cmd + '\n' + JSON.stringify(r.output));
  }
});

test('case 2: a new branch at the remote tip, then edits and copies each with its own passing test, is no change (pin)', () => {
  const c = setup();
  syncForReal(c, 'feat/x');
  const sync = shell('cd "' + bashPath(c.clone) + '" && git switch -q main && git pull -q && git switch -q -c feat/x', c.session);
  assert.equal(stop(sync, c.session).decision, 'allow', 'the new branch alone');
  // An ordinary edit, then its test; a copy, then its test.
  write(path.join(c.clone, 'hooks/one.js'), 'module.exports = 1;\n');
  const first = [...sync, ...edit(path.join(c.clone, 'hooks/one.js'), c.session), ...passingTest(c, 'one.test.js')];
  assert.equal(stop(first, c.session).decision, 'allow', 'an edit and its passing test');
  write(path.join(c.clone, 'hooks/two.js'), 'module.exports = 2;\n');
  const copy = shell('cp "' + bashPath(c.dir) + '/release/hooks/two.js" "' + bashPath(c.clone) + '/hooks/two.js"', c.session);
  const second = [...first, ...copy, ...passingTest(c, 'two.test.js')];
  assert.equal(stop(second, c.session).decision, 'allow', 'a copy and its passing test');
  // Must not change: a later edit with no test after it is owed.
  write(path.join(c.clone, 'hooks/three.js'), 'module.exports = 3;\n');
  const third = stop([...second, ...edit(path.join(c.clone, 'hooks/three.js'), c.session)], c.session);
  assert.equal(third.decision, 'block', 'a later edit with no test');
  assert.match(third.output.reason, NO_CHECK);
});

test('case 3: after the sync only a prose file changed (README.md): the sync is still no change', () => {
  const c = setup();
  syncForReal(c, 'feat/readme');
  const sync = shell('cd "' + bashPath(c.clone) + '" && git status --short | head -3; git switch -q main && git pull -q && git log --oneline -1 && git switch -q -c feat/readme', c.session, 'fc096c2 upstream');
  write(path.join(c.clone, 'README.md'), '# Example\n\nOne more line.\n');
  assert.notEqual(git(c.clone, 'status', '--porcelain'), '', 'precondition: README.md is changed, not committed');
  const readme = edit(path.join(c.clone, 'README.md'), c.session);
  const r = stop([...sync, ...readme], c.session);
  assert.equal(r.decision, 'allow', JSON.stringify(r.output));
  // A new prose file in a new folder, and a deleted one, are prose too.
  write(path.join(c.clone, 'docs/notes/plan.md'), 'plan\n');
  assert.equal(stop([...sync, ...readme], c.session).decision, 'allow', 'an untracked prose file in a new folder');
  fs.rmSync(path.join(c.clone, 'README.md'));
  assert.equal(stop([...sync, ...readme], c.session).decision, 'allow', 'a deleted prose file');
});

test('a move to a fetched remote ref, then only a prose file changed, is no change either', () => {
  const c = setup();
  git(c.clone, 'fetch', '-q');
  git(c.clone, 'checkout', '-q', '--detach', 'origin/main');
  write(path.join(c.clone, 'README.md'), '# Example\n\nA note.\n');
  const r = stop(shell('cd "' + bashPath(c.clone) + '" && git fetch -q && git checkout -q --detach origin/main', c.session), c.session);
  assert.equal(r.decision, 'allow', JSON.stringify(r.output));
});

test('a code file changed in the synced folder with no test after it is still a change (must not change)', () => {
  const c = setup();
  syncForReal(c, 'feat/code');
  const sync = shell('cd "' + bashPath(c.clone) + '" && git switch -q main && git pull -q && git switch -q -c feat/code', c.session);
  write(path.join(c.clone, 'README.md'), '# Example\n\nOne more line.\n');
  const blocked = (what) => {
    const r = stop(sync, c.session);
    assert.equal(r.decision, 'block', what);
    assert.match(r.output.reason, NO_CHECK, what);
  };
  // A changed tracked code file (a copy the transcript does not show), beside the prose file.
  write(path.join(c.clone, 'src/App.cs'), 'class App { int x; }\n');
  blocked('a changed code file beside the prose file');
  git(c.clone, 'checkout', '-q', '--', 'src/App.cs');
  // A new code file inside a new folder: git status names the folder alone unless asked for every file.
  write(path.join(c.clone, 'tools/new/Thing.cs'), 'class Thing {}\n');
  blocked('a new code file in a new folder');
  fs.rmSync(path.join(c.clone, 'tools'), { recursive: true });
  // A staged rename from a code name to a prose name: the old name counts too.
  git(c.clone, 'mv', 'src/App.cs', 'src/App.txt');
  blocked('a code file renamed to a prose name');
  git(c.clone, 'mv', 'src/App.txt', 'src/App.cs');
  // A folder git reports whole (a repository inside the folder) is not prose.
  git(c.clone, 'init', '-q', path.join(c.clone, 'vendor', 'lib'));
  commit(path.join(c.clone, 'vendor', 'lib'), 'lib.cs', 'class Lib {}\n', 'inner');
  blocked('a repository inside the folder');
  fs.rmSync(path.join(c.clone, 'vendor'), { recursive: true, force: true });
  // With a passing test after the sync, the same changed code file is checked.
  write(path.join(c.clone, 'src/App.cs'), 'class App { int x; }\n');
  assert.equal(stop([...sync, ...passingTest(c, 'app.test.js')], c.session).decision, 'allow', 'a test after the sync');
});

test('a sync that lands on local commits is still a change, prose file or not (must not change)', () => {
  const c = setup();
  git(c.clone, 'switch', '-q', '-c', 'local-only');
  commit(c.clone, 'src/Local.cs', 'class Local {}\n', 'local work');
  git(c.clone, 'switch', '-q', 'main');
  git(c.clone, 'switch', '-q', 'local-only');
  assert.ok(!remoteTips(c.clone).includes(treeOf(c.clone, 'HEAD')), 'precondition: no remote tip has this tree');
  write(path.join(c.clone, 'README.md'), '# Example\n\nOne more line.\n');
  const r = stop(shell('cd "' + bashPath(c.clone) + '" && git switch -q local-only', c.session), c.session);
  assert.equal(r.decision, 'block');
  assert.match(r.output.reason, BLAMES_GIT);
});

test('the real case: "git pull" inside the text of a sed command on a notes file is no git change', () => {
  const c = setup();
  syncForReal(c, 'feat/release');
  const sync = shell('cd "' + bashPath(c.clone) + '" && git status --short | head -3; git switch -q main && git pull -q && git log --oneline -1 && git switch -q -c feat/release', c.session, 'fc096c2 upstream');
  // The release files are copied in, tested and committed, as the session did.
  write(path.join(c.clone, 'hooks/one.js'), 'module.exports = 1;\n');
  const copy = shell('cp "' + bashPath(c.dir) + '/release/hooks/one.js" "' + bashPath(c.clone) + '/hooks/one.js"', c.session);
  git(c.clone, 'add', '--', 'hooks/one.js');
  git(c.clone, 'commit', '-q', '-m', 'release');
  const save = shell('cd "' + bashPath(c.clone) + '" && git add hooks/one.js && git commit -q -m release', c.session);
  const tested = [...sync, ...copy, ...passingTest(c, 'one.test.js'), ...save];
  assert.equal(stop(tested, c.session).decision, 'allow', 'precondition: the copy is tested');
  // The command that blocked three stops on 2026-11-16: a status line in a notes file is reworded.
  const notes = "sed -i 's/OWED: user push + PR + merge, then PC 2 git pull + install.ps1 -KeepSettings. Then: medium timed test./PUSHED by the user: PR #53. OWED: CI + merge by the user, then PC 2 git pull + install.ps1 -KeepSettings. Then: medium timed test./' ~/.claude/projects/example/memory/workflow-notes.md && grep -c \"PR #53\" ~/.claude/projects/example/memory/workflow-notes.md";
  const r = stop([...tested, ...shell(notes, c.session, '1')], c.session);
  assert.equal(r.decision, 'allow', JSON.stringify(r.output));
});

test('git words in the text of sed, grep, echo and printf are no git change; a command that runs git still is', () => {
  for (const seg of [
    "sed -i 's/then PC 2 git pull + install/then PC 2 git pull -q + install/' notes.md",
    'grep -n "then git switch -c feat" README.md',
    "grep -rn 'run git checkout main' docs",
    'echo "next: git pull -q on PC 2"',
    'printf "%s" "PC 2: git pull + install.ps1 -KeepSettings"',
    'echo then git pull there',
    'time sed -i "s/run git pull first/run git pull -q first/" notes.md',
  ]) assert.equal(gitChange(seg), false, seg);
  // Must not change: git itself, a wrapper, a shell that runs the text, and text that runs a command
  // (a substitution, a backtick, GNU sed's own `e` command and `e` flag).
  for (const seg of [
    'git pull -q',
    'git -C ../other switch -q main',
    'time git pull -q',
    '(git pull -q)',
    'xargs git checkout',
    'bash -c "cd x && git pull -q"',
    'powershell -Command "cd x; git checkout main"',
    'echo "$(git stash pop)"',
    'echo "moved: ` git checkout main `"',
    'sed -i "s/x/$(git checkout main )/" notes.md',
    'grep -c x <(git checkout main )',
    "sed -n '1e git pull -q' notes.md",
    "sed 's/x/ git pull -q /e' notes.md",
    'if grep -q "a git pull b" notes.md',
  ]) assert.equal(gitChange(seg), true, seg);
});

test('an earlier edit that is still owed is named: the credited sync is not blamed', () => {
  const c = setup();
  syncForReal(c, 'feat/label');
  const sync = shell('cd "' + bashPath(c.clone) + '" && git switch -q main && git pull -q && git switch -q -c feat/label', c.session);
  // The real stop of case 3 also had this: an installer copied into a release folder, never checked.
  const owed = shell('R=C:/repos/handoff/r7\ncp ~/.claude/scripts/workflow-install.sh $R/workflow-install.sh', c.session);
  const r = stop([...owed, ...sync], c.session);
  assert.equal(r.decision, 'block');
  assert.match(r.output.reason, NO_CHECK);
  assert.match(r.output.reason, /last edit: workflow-install\.sh/);
  assert.doesNotMatch(r.output.reason, BLAMES_GIT);
  // An Edit before the sync is named the same way.
  const edited = stop([...edit('C:/repos/example/src/App.cs', c.session), ...sync], c.session);
  assert.equal(edited.decision, 'block');
  assert.match(edited.output.reason, /last edit: App\.cs/);
  assert.doesNotMatch(edited.output.reason, BLAMES_GIT);
  // Must not change: a sync that is itself the change keeps its name.
  write(path.join(c.clone, 'src/App.cs'), 'class App { int x; }\n');
  const dirty = stop(sync, c.session);
  assert.equal(dirty.decision, 'block');
  assert.match(dirty.output.reason, BLAMES_GIT);
});

// Repair round 2026-11-17 (six findings).
test('a stash entry with status.showStash on does not make a clean synced folder dirty', () => {
  const c = setup();
  syncForReal(c);
  write(path.join(c.clone, 'README.md'), '# Example\n\nStashed.\n');
  git(c.clone, 'stash', 'push', '-q', '-m', 'keep');
  assert.equal(git(c.clone, 'status', '--porcelain'), '', 'precondition: the folder is clean');
  const showStash = path.join(root, 'showstash.gitconfig');
  fs.writeFileSync(showStash, '[status]\n\tshowStash = true\n');
  const r = stop(shell('cd "' + bashPath(c.clone) + '" && git switch -q main && git pull -q', c.session), c.session, { ...env, GIT_CONFIG_GLOBAL: showStash });
  assert.equal(r.decision, 'allow', JSON.stringify(r.output));
});

test('a command that runs git inside echo is still a change (PowerShell group, pipe into a shell)', () => {
  for (const seg of ['echo (git stash pop)', 'echo @(git checkout main)', 'Write-Output (git reset --hard HEAD~1)']) {
    assert.equal(gitChange(seg), true, seg);
  }
  assert.ok(scan.shellEditPaths('echo git stash pop | bash').includes('<git>'), 'echo into bash');
  assert.ok(scan.shellEditPaths('echo git checkout main | pwsh -Command -').includes('<git>'), 'echo into pwsh');
  const c = setup();
  const r = stop(shell('echo git stash pop | bash', c.session), c.session);
  assert.equal(r.decision, 'block', 'the transcript scan sees the pipe too');
  assert.match(r.output.reason, BLAMES_GIT);
  // Must not change: plain text without a run.
  assert.equal(scan.shellEditPaths('echo git stash pop | cat').includes('<git>'), false);
});

test('git words in quoted text or a trailing comment of any other program are no git change', () => {
  for (const seg of [
    'git commit -q -m "fix(stop-gate): a git switch in another folder is no change"',
    'Write-Host "next: git pull on PC 2"',
    "awk '/then git pull there/' notes.md",
    'gh pr create --body "run git pull on PC 2 after merge"',
    'ls -la # then git pull later',
    'git status # git pull later',
  ]) assert.equal(gitChange(seg), false, seg);
  // Must not change: git outside the quotes, and a shell that runs the quoted text.
  for (const seg of ['git commit -m "x" && git pull', 'git pull -q # then git pull later', 'bash -c "git pull"', 'pwsh -Command "git checkout main"', 'eval "git pull"', 'Invoke-Expression "git pull"']) {
    assert.equal(gitChange(seg), true, seg);
  }
  const c = setup();
  syncForReal(c, 'feat/msg');
  const sync = shell('cd "' + bashPath(c.clone) + '" && git switch -q main && git pull -q && git switch -q -c feat/msg', c.session);
  write(path.join(c.clone, 'hooks/one.js'), 'module.exports = 1;\n');
  const tested = [...sync, ...edit(path.join(c.clone, 'hooks/one.js'), c.session), ...passingTest(c, 'one.test.js')];
  git(c.clone, 'add', '--', 'hooks/one.js');
  git(c.clone, 'commit', '-q', '-m', 'fix');
  const saved = [...tested, ...shell('cd "' + bashPath(c.clone) + '" && git add hooks/one.js && git commit -q -m "fix(stop-gate): a git switch in another folder is no change"', c.session)];
  assert.equal(stop(saved, c.session).decision, 'allow', 'a commit whose message says git switch');
});

test('the move credited by a fetched ref names the owed edit, in the PowerShell spelling too', () => {
  const c = setup();
  git(c.clone, 'fetch', '-q');
  git(c.clone, 'checkout', '-q', '--detach', 'origin/main');
  const owedEdit = edit('C:/repos/example/src/App.cs', c.session);
  const ps = shell('cd "' + c.clone + '"; git fetch -q; git checkout -q --detach origin/main', c.session, '', 'PowerShell');
  const r = stop([...owedEdit, ...ps], c.session);
  assert.equal(r.decision, 'block');
  assert.match(r.output.reason, /last edit: App\.cs/);
  assert.doesNotMatch(r.output.reason, BLAMES_GIT);
});

test('a git change behind a quoted or escaped -C path with a space is seen', () => {
  for (const seg of [
    'git -C "C:/My Projects/app" pull -q',
    "git -C 'C:/My Projects/app' reset --hard HEAD~1",
    'git -C "/c/Users/Asus/My Projects/app" stash pop',
    'git -C /c/My\\ Projects/app pull',
    'git -C "a b" -C "c d" merge x',
  ]) assert.equal(gitChange(seg), true, seg);
  const c = setup();
  const r = stop(shell('git -C "' + bashPath(c.dir) + '/chk sw other-x/case 1/clone" reset -q --hard HEAD~2', c.session), c.session);
  assert.equal(r.decision, 'block');
  assert.match(r.output.reason, BLAMES_GIT);
});
