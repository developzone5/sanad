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
inspect() {
  local file="$d/$1-state" row state restarts health
  row='exited 0 unhealthy'
  if [ -s "$file" ]; then
    row=$(head -1 "$file")
    if [ "$(wc -l < "$file")" -gt 1 ]; then
      tail -n +2 "$file" > "$file.next"; mv "$file.next" "$file"
    fi
  fi
  read -r state restarts health <<< "$row"
  case "$cmd" in
    *'{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}'*) echo "$row" ;;
    *'{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'*)
      if [ "$health" = '-' ]; then echo "$state"; else echo "$health"; fi ;;
    *'{{if .State.Health}}x{{end}}'*) [ "$health" = '-' ] || echo x ;;
    *) exit 1 ;;
  esac
}
case "$cmd" in
  "echo ok")
    [ -f "$d/all-down" ] && exit 255
    if [ -f "$d/name-down" ] && ! printf '%s ' "$@" | grep -q HostName=; then exit 255; fi
    echo ok ;;
  *"docker info"*) if [ -f "$d/engine-up" ]; then echo 29.9.2; else echo "error during connect" >&2; exit 1; fi ;;
  *schtasks*) touch "$d/engine-up" ;;
  *docker-hold.txt*) echo "$cmd" > "$d/hold.txt" ;;
  *"docker inspect"*eduquest-api) inspect app ;;
  *"docker inspect"*eduquest-mysql) inspect db ;;
  *"docker logs --tail 20 "*) echo 'last line from stdout'; echo 'last line from stderr' >&2 ;;
  *"compose up"*app)
    if [ -f "$d/app-after-up" ]; then cp "$d/app-after-up" "$d/app-state"
    elif [ ! -f "$d/app-stuck" ]; then echo 'running 0 healthy' > "$d/app-state"; fi ;;
  *"compose up"*) [ ! -f "$d/db-stuck" ] && echo 'running 0 healthy' > "$d/db-state" ;;
  'HEAL-APP "C:\\repo path"') rm -f "$d/app-stuck" ;;
  HEAL-DB) rm -f "$d/db-stuck" ;;
  HEAL-FAIL) exit 5 ;;
  HEAL-HANG) exec sleep 30 ;;
  *) exit 1 ;;
esac
`;

function setup({ files = [], config = {}, settings = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  for (const f of files) fs.writeFileSync(path.join(bin, f), '');
  // Only this test's settings: the real global ones (this machine has a remote) must not leak in.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
  const gitDir = path.join(repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'objects'));
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  const entries = Object.entries(config).map(([key, value]) => `\t${key.slice('sanad.'.length)} = ${JSON.stringify(value)}\n`);
  fs.writeFileSync(path.join(gitDir, 'config'), '[sanad]\n' + entries.join(''));
  // The fake ssh first, then Git's tools (date, grep, tr), then the rest; one PATH key only.
  const env = { ...gitEnv, PREFLIGHT_WAIT_SECONDS: '5', PREFLIGHT_STEP_SECONDS: '0', ...settings };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [bin, BASH.tools, process.env.PATH].filter(Boolean).join(path.delimiter);
  const run = (...args) => {
    const r = spawnSync(BASH.exe, [script, ...args], { cwd: repo, encoding: 'utf8', env, timeout: 20000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const calls = () => fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').trim().split('\n');
  const write = (name, value) => fs.writeFileSync(path.join(bin, name), value);
  return { root, bin, run, calls, write };
}

const db = { 'sanad.remoteHost': 'pc2', 'sanad.remoteDbUp': 'cd /d C:\\repo && docker compose up -d --pull never mysql', 'sanad.remoteDbContainer': 'eduquest-mysql' };
const app = { 'sanad.remoteAppUp': 'cd /d C:\\repo && docker compose up -d --no-build --pull never app', 'sanad.remoteAppContainer': 'eduquest-api' };

// 2026-11-09 (TUW-239): the app was started at the end for the browser check, about 1.5 minutes of waiting.
test('--app starts the app beside the database, under the same hold; --app without settings refuses', () => {
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
  fs.writeFileSync(path.join(bin, 'db-state'), 'running 0 healthy\n');
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

test('--connect only checks SSH and keeps the address fallback', () => {
  const t = setup({ files: ['name-down'], config: { ...db, 'sanad.remoteAddress': '10.20.40.46' } });
  try {
    const r = t.run('--connect');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^READY pc2 ssh$/m);
    assert.match(r.out, /answered at 10\.20\.40\.46/);
    assert.equal(t.calls().length, 2);
    assert.ok(t.calls().every(line => line.endsWith('pc2 echo ok')));
    assert.equal(t.run('--connect', '--db').code, 1);
    assert.equal(t.calls().length, 2);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('two exited polls end the wait and show both streams from Docker logs', () => {
  const t = setup({ files: ['engine-up', 'app-stuck'], config: { ...db, ...app }, settings: { PREFLIGHT_WAIT_SECONDS: '60' } });
  try {
    const r = t.run('--app');
    assert.equal(r.code, 8, r.out);
    assert.match(r.out, /^APP-DOWN: eduquest-api on pc2 is exited/m);
    assert.match(r.out, /last line from stdout\n +last line from stderr/);
    assert.equal(t.calls().filter(line => line.includes('docker inspect')).length, 3);
    assert.equal(t.calls().filter(line => line.includes('compose up')).length, 1);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('a growing restart count ends the wait even if the last poll says running', () => {
  const t = setup({ files: ['engine-up'], config: { ...db, ...app }, settings: { PREFLIGHT_WAIT_SECONDS: '60' } });
  try {
    t.write('app-after-up', 'restarting 0 starting\nrunning 1 starting\nrunning 1 healthy\n');
    const r = t.run('--app');
    assert.equal(r.code, 8, r.out);
    assert.match(r.out, /restart count grew from 0 to 1/);
    assert.equal(t.calls().filter(line => line.includes('docker inspect')).length, 3);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('starting health is waited for, and a container without a health check can be ready', () => {
  const t = setup({ files: ['engine-up'], config: { ...db, ...app } });
  try {
    t.write('app-after-up', 'running 0 starting\nrunning 0 starting\nrunning 0 healthy\n');
    t.write('db-state', 'running 0 -\n');
    const r = t.run('--db', '--app');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^READY pc2 docker 29\.9\.2 db eduquest-mysql running app eduquest-api healthy/m);
    assert.equal(t.calls().filter(line => line.includes('compose up')).length, 1);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('starting health still has a time limit', () => {
  const t = setup({ files: ['engine-up'], config: { ...db, ...app }, settings: { PREFLIGHT_WAIT_SECONDS: '2' } });
  try {
    t.write('app-after-up', 'running 0 starting\n');
    const r = t.run('--app');
    assert.equal(r.code, 8, r.out);
    assert.match(r.out, /^APP-DOWN: eduquest-api on pc2 is running \(health starting\) after 2s/m);
    assert.ok(t.calls().filter(line => line.includes('docker inspect')).length > 2);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('the app heal runs with its quotes and spaces, then the app starts once more', () => {
  const heal = 'HEAL-APP "C:\\repo path"';
  const t = setup({ files: ['engine-up', 'app-stuck'], config: { ...db, ...app, 'sanad.remoteAppHeal': heal } });
  try {
    const r = t.run('--app');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^NOTE: running sanad\.remoteAppHeal once for eduquest-api on pc2$/m);
    assert.match(r.out, /^READY pc2 docker 29\.9\.2 app eduquest-api healthy/m);
    assert.deepEqual(t.calls().filter(line => /compose up|HEAL-APP/.test(line)).map(line => line.split(' pc2 ')[1]),
      [app['sanad.remoteAppUp'], heal, app['sanad.remoteAppUp']]);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('the database uses its own heal key and retry', () => {
  const t = setup({ files: ['engine-up', 'db-stuck'], config: { ...db, 'sanad.remoteDbHeal': 'HEAL-DB', 'sanad.remoteAppHeal': 'HEAL-FAIL' } });
  try {
    const r = t.run('--db');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^NOTE: running sanad\.remoteDbHeal once for eduquest-mysql on pc2$/m);
    assert.match(r.out, /^READY pc2 docker 29\.9\.2 db eduquest-mysql healthy/m);
    assert.equal(t.calls().filter(line => line.endsWith('HEAL-DB')).length, 1);
    assert.equal(t.calls().filter(line => line.includes('compose up')).length, 2);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

for (const [heal, message] of [['HEAL-FAIL', /heal failed \(exit 5\)/], ['HEAL-HANG', /heal timed out after 1s/]]) {
  test(`${heal} ends with APP-DOWN and no retry`, () => {
    const t = setup({ files: ['engine-up', 'app-stuck'], config: { ...db, ...app, 'sanad.remoteAppHeal': heal }, settings: { PREFLIGHT_HEAL_SECONDS: '1' } });
    try {
      const r = t.run('--app');
      assert.equal(r.code, 8, r.out);
      assert.match(r.out, /^APP-DOWN: /m);
      assert.match(r.out, message);
      assert.match(r.out, /last line from stderr/);
      assert.equal(t.calls().filter(line => line.endsWith(heal)).length, 1);
      assert.equal(t.calls().filter(line => line.includes('compose up')).length, 1);
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });
}
