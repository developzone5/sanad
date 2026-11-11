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
  *"status --porcelain"*) : ;;
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
