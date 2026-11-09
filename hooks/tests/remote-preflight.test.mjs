import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'remote', 'remote-preflight.sh');

// Git's own bash and its tools. On Windows, `bash` on PATH can be the WSL launcher
// (C:\Windows\System32\bash.exe), which fails with no Linux installed (2026-11-09: the
// test machine, over SSH, where Git's usr\bin is not on PATH either).
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

// A fake ssh that plays the remote machine: its state lives in files next to it.
const FAKE_SSH = `#!/usr/bin/env bash
d="$(dirname "$0")"
cmd="\${@: -1}"
echo "$*" >> "$d/calls.log"
case "$cmd" in
  "echo ok")
    [ -f "$d/all-down" ] && exit 255
    if [ -f "$d/name-down" ] && ! printf '%s ' "$@" | grep -q HostName=; then exit 255; fi
    echo ok ;;
  *"docker info"*) if [ -f "$d/engine-up" ]; then echo 29.9.2; else echo "error during connect" >&2; exit 1; fi ;;
  *schtasks*) touch "$d/engine-up" ;;
  *docker-hold.txt*) echo "$cmd" > "$d/hold.txt" ;;
  *"Health}}x{{end}}"*) echo x ;;
  *"docker inspect"*eduquest-api) if [ -f "$d/app-state" ]; then cat "$d/app-state"; else echo exited; fi ;;
  *"docker inspect"*) if [ -f "$d/db-state" ]; then cat "$d/db-state"; else echo exited; fi ;;
  *"compose up"*app) echo healthy > "$d/app-state" ;;
  *"compose up"*) echo healthy > "$d/db-state" ;;
  *) exit 1 ;;
esac
`;

function setup({ files = [], config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  for (const f of files) fs.writeFileSync(path.join(bin, f), '');
  // Only this test's settings: the real global ones (this machine has a remote) must not leak in.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
  execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv });
  for (const [k, v] of Object.entries(config)) execFileSync('git', ['config', k, v], { cwd: repo, env: gitEnv });
  // The fake ssh first, then Git's tools (date, grep, tr), then the rest; one PATH key only.
  const env = { ...gitEnv, PREFLIGHT_WAIT_SECONDS: '5', PREFLIGHT_STEP_SECONDS: '0' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [bin, BASH.tools, process.env.PATH].filter(Boolean).join(path.delimiter);
  const run = (...args) => {
    const r = spawnSync(BASH.exe, [script, ...args], { cwd: repo, encoding: 'utf8', env });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  return { root, bin, run };
}

const db = { 'sanad.remoteHost': 'pc2', 'sanad.remoteDbUp': 'cd /d C:\\repo && docker compose up -d --pull never mysql', 'sanad.remoteDbContainer': 'eduquest-mysql' };

// 2026-11-09 (TUW-239): the app was started at the end for the browser check, about 1.5 minutes of waiting.
test('--app starts the app beside the database, under the same hold; --app without settings refuses', () => {
  const app = { 'sanad.remoteAppUp': 'cd /d C:\\repo && docker compose up -d --no-build --pull never app', 'sanad.remoteAppContainer': 'eduquest-api' };
  const { root, bin, run } = setup({ files: ['engine-up'], config: { ...db, ...app } });
  const r = run('--db', '--app');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /READY pc2 docker 29\.9\.2 db eduquest-mysql healthy app eduquest-api healthy \(held until /);
  const calls = fs.readFileSync(path.join(bin, 'calls.log'), 'utf8');
  assert.ok(calls.indexOf('docker-hold.txt') < calls.indexOf('compose up'), 'the hold is written before anything starts');
  fs.rmSync(root, { recursive: true, force: true });

  const bare = setup({ files: ['engine-up'], config: db });
  const missing = bare.run('--app');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /--app needs git config sanad\.remoteAppUp and sanad\.remoteAppContainer/);
  fs.rmSync(bare.root, { recursive: true, force: true });
});

test('name down, address answers, engine closed, database stopped: all fixed, then READY with a hold', () => {
  const { root, bin, run } = setup({ files: ['name-down'], config: { ...db, 'sanad.remoteAddress': '10.20.40.46' } });
  const r = run('--db', '--hold', '90');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /answered at 10\.20\.40\.46/);
  assert.match(r.out, /opening it/);
  assert.match(r.out, /READY pc2 docker 29\.9\.2 db eduquest-mysql healthy \(held until \d{4}-\d\d-\d\dT/);
  assert.match(fs.readFileSync(path.join(bin, 'hold.txt'), 'utf8'), /^echo \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ> %USERPROFILE%\\\.claude\\docker-hold\.txt/);
  const calls = fs.readFileSync(path.join(bin, 'calls.log'), 'utf8');
  assert.ok(calls.indexOf('docker-hold.txt') < calls.indexOf('compose up'), 'the hold is written before the database starts');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a healthy database and a running engine are left alone', () => {
  const { root, bin, run } = setup({ files: ['engine-up'], config: db });
  fs.writeFileSync(path.join(bin, 'db-state'), 'healthy\n');
  const r = run('--db');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /NOTE/);
  const calls = fs.readFileSync(path.join(bin, 'calls.log'), 'utf8');
  assert.doesNotMatch(calls, /schtasks|compose up/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no machine answers: REMOTE-DOWN, and nothing runs there', () => {
  const { root, run } = setup({ files: ['all-down'], config: { ...db, 'sanad.remoteAddress': '10.0.0.9' } });
  const r = run('--db');
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /REMOTE-DOWN: pc2 does not answer/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('without --db only the engine is checked; --db without settings refuses', () => {
  const { root, run } = setup({ files: ['engine-up'], config: { 'sanad.remoteHost': 'pc2' } });
  const plain = run();
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /^READY pc2 docker 29\.9\.2$/m);
  const missing = run('--db');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /needs git config sanad\.remoteDbUp/);
  assert.equal(run('--hold', 'soon').code, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no remote set: NO-REMOTE', () => {
  const { root, run } = setup();
  const r = run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /NO-REMOTE/);
  fs.rmSync(root, { recursive: true, force: true });
});
