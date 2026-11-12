import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'remote', 'remote-sync.sh');

// Git's own bash and its tools (see remote-preflight.test.mjs: `bash` on PATH can be the WSL launcher).
function gitBash() {
  if (process.platform !== 'win32') return { exe: 'bash', tools: '' };
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    const tools = path.resolve(exec, '..', '..', '..', 'usr', 'bin');
    if (fs.existsSync(path.join(tools, 'bash.exe'))) return { exe: path.join(tools, 'bash.exe'), tools };
  } catch { /* no git on PATH: fall back to PATH */ }
  return { exe: 'bash', tools: '' };
}
const BASH = gitBash();

// A fake test machine. Its clone holds ONE bundle file name, as the real one does: the copy puts it
// there, the fetch reads it and deletes it. A fetch that finds no bundle fails.
const FAKE_SSH = `#!/usr/bin/env bash
d="$(dirname "$0")"
cmd="\${@: -1}"
case "$cmd" in
  "echo ok") echo ok ;;
  *"--untracked-files=no"*) : ;;
  *"status --porcelain"*) cat "$d/status" 2>/dev/null ;;
  *"fetch -q origin"*) : ;;
  *"sanad-run.bundle"*) mv "$d/bundle" "$d/taken.$$" 2>/dev/null || exit 1 ;;
  *"checkout -q --detach"*) : ;;
  *"rev-parse HEAD"*) cat "$d/tree" ;;
  *) exit 1 ;;
esac
`;
// The copy waits a few seconds for a second copy: two syncs that run at the same time always meet here,
// and then only one of them finds the bundle. A sync that runs alone goes on after the wait.
const FAKE_SCP = `#!/usr/bin/env bash
d="$(dirname "$0")"
touch "$d/bundle" "$d/scp.$$"
for i in $(seq 1 25); do
  [ "$(ls "$d"/scp.* 2>/dev/null | wc -l)" -ge 2 ] && break
  sleep 0.2
done
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-sync-'));
  const bin = path.join(root, 'bin'), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  for (const d of [bin, repo, state]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'scp'), FAKE_SCP, { mode: 0o755 });
  // Only this test's settings: the real global ones (this machine has a remote) must not leak in.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'sanad.remoteHost', 'pc2'); git('config', 'sanad.remoteRepo', 'C:/repos/App');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt'); git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(bin, 'tree'), git('rev-parse', 'HEAD^{tree}') + '\n');
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [bin, BASH.tools, process.env.PATH].filter(Boolean).join(path.delimiter);
  const run = () => new Promise((resolve) => {
    const child = spawn(BASH.exe, [script], { cwd: repo, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  return { root, state, run };
}

// 2026-11-11 (TUW-243): the server's proof and the page's proof started together. Both syncs used the one
// bundle name; the first fetch deleted the bundle the second was about to fetch: "FAILED: fetch the bundle".
test('two syncs started together both finish: the second waits for the first', async () => {
  const { root, state, run } = setup();
  try {
    const results = await Promise.all([run(), run()]);
    for (const r of results) {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /^SYNCED pc2:C:\/repos\/App [0-9a-f]{40} tree [0-9a-f]{40}$/m);
    }
    assert.equal(fs.existsSync(path.join(state, 'remote-sync.lock')), false, 'the lock is gone when both are done');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 2026-11-12: every worktree of a repository shares the ONE clone on the test machine. A sync from a
// second task changed the code under the first task's running suite (or under its browser-check app),
// and the first task still got "passed". The sync now refuses while another task holds the clone.
function checkLock(state, { toplevel, pid = process.pid, minutes = 10,
  command = 'C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes pc2 cd /d C:\\repos\\App\\Server && dotnet test' }) {
  const dir = path.join(state, 'check-locks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, Math.random().toString(16).slice(2) + '.json'), JSON.stringify({ toplevel, pid,
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + minutes * 60000).toISOString(), command }));
}

test("a sync is refused while another task's check runs in the test machine's clone", async () => {
  const { root, state, run } = setup();
  try {
    checkLock(state, { toplevel: 'C:/work/other-task' });
    const r = await run();
    assert.equal(r.code, 11, r.out);
    assert.match(r.out, /^REMOTE-BUSY: a check of C:\/work\/other-task is running in pc2:C:\/repos\/App/m);
    assert.doesNotMatch(r.out, /SYNCED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("this folder's own check, a check that is gone or expired, and a check outside the clone do not block a sync", async () => {
  const { root, state, run } = setup();
  try {
    checkLock(state, { toplevel: path.join(root, 'repo') });
    checkLock(state, { toplevel: 'C:/work/other-task', pid: 999999 });
    checkLock(state, { toplevel: 'C:/work/other-task', minutes: -1 });
    checkLock(state, { toplevel: 'C:/work/other-task', command: 'ssh pc2 cd /d C:\\repos\\Else && dotnet test' });
    checkLock(state, { toplevel: 'C:/work/other-task', command: 'node node_modules/vitest/vitest.mjs run' });
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^SYNCED /m);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a sync is refused while another task's browser-check app is served from the clone, not for its own app or a dead link", async () => {
  const { root, state, run } = setup();
  try {
    const owner = path.join(state, 'remote-web-pc2.owner'), link = path.join(state, 'remote-web-pc2.link');
    fs.writeFileSync(owner, 'C:/work/other-task\n');
    fs.writeFileSync(link, `1 ${process.pid} 3000 5050\n`);
    const other = await run();
    assert.equal(other.code, 11, other.out);
    assert.match(other.out, /^REMOTE-BUSY: the browser-check app of C:\/work\/other-task is served from pc2:C:\/repos\/App/m);
    assert.match(other.out, /remote-web\.sh stop/);

    fs.writeFileSync(link, '1 999999 3000 5050\n');
    assert.equal((await run()).code, 0, 'a link that is gone holds nothing');

    fs.writeFileSync(owner, path.join(root, 'repo') + '\n');
    fs.writeFileSync(link, `1 ${process.pid} 3000 5050\n`);
    assert.equal((await run()).code, 0, 'its own app does not block its own sync');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('files on the test machine that are not in git make its clone dirty: they would be compiled into the run', async () => {
  const { root, run } = setup();
  try {
    fs.writeFileSync(path.join(root, 'bin', 'status'), '?? Server/Leftover.cs\n');
    const r = await run();
    assert.equal(r.code, 5, r.out);
    assert.match(r.out, /^REMOTE-DIRTY: /m);
    assert.match(r.out, /Leftover\.cs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a lock left by a sync that is gone is taken over at once', async () => {
  const { root, state, run } = setup();
  try {
    fs.mkdirSync(path.join(state, 'remote-sync.lock'));
    fs.writeFileSync(path.join(state, 'remote-sync.lock', 'pid'), '999999\n');
    const started = Date.now();
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^SYNCED /m);
    assert.ok(Date.now() - started < 30000, 'no long wait for a process that is gone');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
