import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// check-lock-guard.js against a real repository and real lock files. The tests share one lock
// folder, so they run in order and each starts by clearing it. No command under test is run.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(hooks, 'check-lock-guard.js');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'check-lock-guard-')));
const repo = path.join(root, 'repo');
const sibling = path.join(root, 'repo-extra'); // shares the repository's name as a prefix
const locks = path.join(root, 'locks');
for (const dir of [repo, sibling, path.join(repo, 'src')]) fs.mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q'); git('config', 'user.name', 'Lock fixture'); git('config', 'user.email', 'fixture@example.invalid');
fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 1;\n');
git('add', '-A'); git('commit', '-qm', 'fixture');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// `pidStartedAt` left out writes the old lock format (no start time).
function writeLock({ pid = process.pid, expires = Date.now() + 600000, toplevel = repo, name = 'run-1', raw, pidStartedAt } = {}) {
  fs.mkdirSync(locks, { recursive: true });
  const file = path.join(locks, name + '.json');
  fs.writeFileSync(file, raw ?? JSON.stringify({ toplevel, pid, pidStartedAt, runId: name, startedAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString(), command: 'node vitest.mjs run' }));
  return file;
}
// When this process started, as evidence.mjs records its own start in a lock.
const ownStart = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
// A process id no system hands out (above Linux's pid_max limit, macOS's 99999 and any Windows id in use).
const NO_PROCESS = 2147483644;
function clearLocks() { fs.rmSync(locks, { recursive: true, force: true }); }
function decide(tool, toolInput, cwd = repo) {
  const run = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd }),
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, SANAD_CHECK_LOCK_DIR: locks },
  });
  assert.equal(run.status, 0, run.stderr);
  const h = (run.stdout.trim() ? JSON.parse(run.stdout) : {}).hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '' };
}
const app = path.join(repo, 'src', 'app.js');

test('no lock: every edit is allowed', () => {
  clearLocks();
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow');
  assert.equal(decide('Bash', { command: 'echo 2 > src/app.js' }).decision, 'allow');
});

test('a live lock refuses an edit, a new file and a notebook inside its repository', () => {
  clearLocks();
  const file = writeLock();
  const edit = decide('Edit', { file_path: app });
  assert.equal(edit.decision, 'deny');
  assert.match(edit.reason, /voids the whole run/);
  assert.ok(edit.reason.includes(file), 'names the lock file for a stale-lock cleanup');
  assert.equal(decide('Write', { file_path: path.join(repo, 'src', 'new.ts') }).decision, 'deny', 'an untracked file joins the tree too');
  assert.equal(decide('MultiEdit', { file_path: 'src/app.js' }).decision, 'deny', 'a relative path is read from the session folder');
  assert.equal(decide('NotebookEdit', { notebook_path: path.join(repo, 'n.ipynb') }).decision, 'deny');
  assert.equal(decide('Write', { file_path: path.join(repo, 'README.md') }).decision, 'deny', 'docs are in the tree as well');
});

test('ignored paths, other folders and a same-prefix sibling stay open', () => {
  clearLocks();
  writeLock();
  assert.equal(decide('Write', { file_path: path.join(repo, 'ignored', 'out.js') }).decision, 'allow');
  assert.equal(decide('Edit', { file_path: path.join(sibling, 'app.js') }, sibling).decision, 'allow');
  assert.equal(decide('Edit', { file_path: path.join(os.tmpdir(), 'scratch.js') }).decision, 'allow');
});

test('another spelling of the same path is still refused on Windows', { skip: process.platform !== 'win32' }, () => {
  clearLocks();
  writeLock();
  assert.equal(decide('Edit', { file_path: app.toUpperCase().replace(/\\/g, '/') }).decision, 'deny');
});

// 2026-11-13: on a CI runner the id of a just-finished process went to the next process at once, so the
// "finished process" lock of this test looked alive and blocked. The gone process now has an id no system
// hands out; an id that went to a later process is the next test's case.
test('stale locks never block: a finished process or a passed deadline removes them; a half-written one is skipped', () => {
  clearLocks();
  const gone = writeLock({ pid: NO_PROCESS, name: 'gone' });
  const expired = writeLock({ expires: Date.now() - 1000, name: 'expired' });
  const partial = writeLock({ name: 'partial', raw: '{"toplevel":' });
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow');
  assert.equal(fs.existsSync(gone), false);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(partial), true, 'a lock being written is never deleted');
});

test('a lock whose process id now belongs to a later process is stale: same id, other start time', () => {
  clearLocks();
  const reused = writeLock({ pidStartedAt: new Date(Date.parse(ownStart()) - 3600000).toISOString(), name: 'reused' });
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow');
  assert.equal(fs.existsSync(reused), false, 'the stale lock is removed');
});

test('same process id and same start time: the lock blocks', () => {
  clearLocks();
  const file = writeLock({ pidStartedAt: ownStart(), name: 'same' });
  const edit = decide('Edit', { file_path: app });
  assert.equal(edit.decision, 'deny');
  assert.ok(edit.reason.includes(file));
  assert.equal(fs.existsSync(file), true);
});

test('a lock in the old format (no start time) keeps the process id check alone', () => {
  clearLocks();
  const live = writeLock({ name: 'old-live' });
  assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).pidStartedAt, undefined);
  assert.equal(decide('Edit', { file_path: app }).decision, 'deny', 'a live id blocks, as before');
  clearLocks();
  const gone = writeLock({ pid: NO_PROCESS, name: 'old-gone' });
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow', 'a gone id never blocks, as before');
  assert.equal(fs.existsSync(gone), false);
});

// The start time evidence.mjs writes and the one this hook reads from the system agree on this machine,
// so a real check's lock blocks while it runs (a wrong reading would let an edit void the run).
test('a real check (evidence.mjs) holds a lock this hook honours while the check runs', async () => {
  clearLocks();
  const { runCommand } = await import('../../skills/gate/scripts/evidence.mjs');
  const previous = process.env.SANAD_CHECK_LOCK_DIR;
  process.env.SANAD_CHECK_LOCK_DIR = locks;
  try {
    const ask = `const r=require("node:child_process").spawnSync(process.execPath,[${JSON.stringify(hook)}],{input:${JSON.stringify(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: app }, cwd: repo }))},encoding:"utf8",windowsHide:true});process.stdout.write(r.stdout)`;
    const run = await runCommand({ executable: process.execPath, args: ['-e', ask], cwd: repo, outputRoot: path.join(root, 'evidence-out'), timeoutMs: 60000 });
    const out = fs.readFileSync(run.stdout, 'utf8');
    assert.equal(run.status, 'passed', out);
    assert.match(out, /"permissionDecision":"deny"/, out);
    assert.deepEqual(fs.readdirSync(locks), [], 'released when the check ends');
  } finally {
    if (previous === undefined) delete process.env.SANAD_CHECK_LOCK_DIR; else process.env.SANAD_CHECK_LOCK_DIR = previous;
  }
});

test('shell commands: writes, git content changes and generated files in the repository are refused; reads are not', () => {
  clearLocks();
  writeLock();
  assert.equal(decide('Bash', { command: 'echo 2 > src/app.js' }).decision, 'deny');
  assert.equal(decide('PowerShell', { command: 'Set-Content -Path src/app.js -Value 2' }).decision, 'deny');
  assert.equal(decide('Bash', { command: 'git checkout -b other' }).decision, 'deny');
  assert.equal(decide('PowerShell', { command: `git -C ${repo} stash push -m wip` }, sibling).decision, 'deny', 'git -C names the changed folder');
  assert.equal(decide('Bash', { command: 'npm install left-pad' }).decision, 'deny');
  assert.equal(decide('Bash', { command: 'git status --short' }).decision, 'allow');
  assert.equal(decide('Bash', { command: 'git stash list' }).decision, 'allow');
  assert.equal(decide('Bash', { command: 'cat src/app.js && grep -n value src/app.js' }).decision, 'allow');
  assert.equal(decide('Bash', { command: 'echo 2 > ignored/out.js' }).decision, 'allow');
  assert.equal(decide('Bash', { command: 'git checkout -b other' }, sibling).decision, 'allow', 'a switch in another repository');
});

// 2026-11-12 (audit H14): the check records every file git does not ignore, so any shell write or delete
// there voids it, not only a code file; formatters rewrite code. Reads, ignored paths and null sinks stay open.
test('shell commands: any write or delete of a non-ignored file in the repository is refused', () => {
  clearLocks();
  writeLock();
  for (const [tool, command] of [['Bash', 'echo note >> notes.md'], ['Bash', 'rm README.md'], ['Bash', 'rm -rf src'], ['PowerShell', 'Remove-Item -Path docs/old.md'],
    ['Bash', "sed -i 's/a/b/' notes.md"], ['Bash', 'touch new.txt'], ['Bash', 'mv README.md docs.md'], ['Bash', 'git rm -q README.md'],
    ['PowerShell', '"x" | Out-File -FilePath notes.md'], ['Bash', 'npx prettier --write .'], ['Bash', 'dotnet format'], ['Bash', 'cd src && echo x > notes.txt'],
    ['Bash', `echo x > "${repo.replace(/\\/g, '/')}/specs/a.md"`]]) {
    assert.equal(decide(tool, { command }).decision, 'deny', command);
  }
  for (const [tool, command] of [['Bash', 'cat README.md && grep -n x notes.md'], ['Bash', 'echo x > /dev/null'], ['PowerShell', 'dotnet test 2>$null'], ['Bash', 'rm -rf ignored/tmp'],
    ['Bash', "sed -n '1,5p' README.md"], ['Bash', 'cp README.md ignored/copy.md'], ['Bash', `echo x > "${path.join(os.tmpdir(), 'outside.md').replace(/\\/g, '/')}"`],
    ['Bash', 'git commit -m "rm notes.md > x"'], ['Bash', 'dotnet format --verify-no-changes']]) {
    assert.equal(decide(tool, { command }).decision, 'allow', command);
  }
});

test('a lock on another repository leaves this one open', () => {
  clearLocks();
  writeLock({ toplevel: sibling });
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow');
  assert.equal(decide('Edit', { file_path: path.join(sibling, 'x.js') }, sibling).decision, 'deny');
});
