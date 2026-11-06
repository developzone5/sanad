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

function writeLock({ pid = process.pid, expires = Date.now() + 600000, toplevel = repo, name = 'run-1', raw } = {}) {
  fs.mkdirSync(locks, { recursive: true });
  const file = path.join(locks, name + '.json');
  fs.writeFileSync(file, raw ?? JSON.stringify({ toplevel, pid, runId: name, startedAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString(), command: 'node vitest.mjs run' }));
  return file;
}
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

test('stale locks never block: a finished process or a passed deadline removes them; a half-written one is skipped', () => {
  clearLocks();
  const done = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  const dead = writeLock({ pid: done.pid, name: 'dead' });
  const expired = writeLock({ expires: Date.now() - 1000, name: 'expired' });
  const partial = writeLock({ name: 'partial', raw: '{"toplevel":' });
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow');
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(partial), true, 'a lock being written is never deleted');
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

test('a lock on another repository leaves this one open', () => {
  clearLocks();
  writeLock({ toplevel: sibling });
  assert.equal(decide('Edit', { file_path: app }).decision, 'allow');
  assert.equal(decide('Edit', { file_path: path.join(sibling, 'x.js') }, sibling).decision, 'deny');
});
