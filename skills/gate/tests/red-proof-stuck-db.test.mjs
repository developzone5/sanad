import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 2026-11-15 (role-sync task), two proof time losses:
// 1. One break kept a lock held, so its run waited the full 15 minutes while its peers had each finished in about
//    4. A red run still going at twice the slowest finished red run (never under a fifth of the limit) is stuck now.
// 2. The database on the test machine had stopped, and the proof found out only from its first run. A dotnet proof
//    there now runs remote-preflight.sh --db first, when git config sanad.remoteDbContainer is set.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-stuck-db-'));
const repos = [];
test.after(() => {
  for (const repo of repos) spawnSync(process.execPath, [script, '--repo', repo, '--drop-copies'], { windowsHide: true, env: env() });
  fs.rmSync(root, { recursive: true, force: true });
});
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = fs.mkdtempSync(path.join(root, 'state-'));
function env(extra = {}) { return { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state, ...extra }; }
const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: env(extra) });

let n = 0;
// Three rules, one test each. Breaking r1 or r2 fails its test at once; breaking r3 hangs, with a child process.
function fixture() {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  repos.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: env() }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  for (const r of ['r1', 'r2', 'r3']) fs.writeFileSync(path.join(repo, r + '.cjs'), 'module.exports = { on: true };\n');
  git('add', '.'); git('commit', '-qm', 'rules');
  const pidFile = path.join(root, `hang${n}.pid`);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.test.cjs'), "describe('rules', () => {\n  it('rule one holds', () => {});\n  it('rule two holds', () => {});\n  it('rule three holds', () => {});\n});\n");
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const fails = [];',
    'if (!require("./r1.cjs").on) fails.push(" FAIL  src/a.test.cjs > rules > rule one holds", "AssertionError: expected false to be true");',
    'if (!require("./r2.cjs").on) fails.push(" FAIL  src/a.test.cjs > rules > rule two holds", "AssertionError: expected false to be true");',
    'if (!require("./r3.cjs").on) {',
    '  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `  require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    '  setInterval(() => {}, 1000);',
    '} else if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  const breaks = path.join(root, `breaks${n}.json`);
  fs.writeFileSync(breaks, JSON.stringify(['one', 'two', 'three'].map((w, i) => ({ name: `rule ${w} off`, file: `r${i + 1}.cjs`, find: 'on: true', put: 'on: false', mustFail: [`rule ${w} holds`] }))));
  return { repo, git, breaks, pidFile };
}
function gone(pid) {
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
  }
  return false;
}

test('a red run still going at twice the slowest finished red run is stopped as stuck, long before the time limit', () => {
  const { repo, breaks, pidFile } = fixture();
  const rule = fs.readFileSync(path.join(repo, 'r3.cjs'));
  const started = Date.now();
  // Limit 60 s: its fifth (12 s) is the floor while the two other breaks finish in under 6 s (on a busy machine
  // they take longer, and the stuck point moves up with them).
  const r = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '4', '--timeout-min', '1', '--', process.execPath, 'check.cjs']);
  const took = Date.now() - started;
  assert.equal(r.status, 5, r.stdout + r.stderr);
  const at = /ran break rule three off: stopped as stuck \(twice the slowest finished run: (\d+) s\)/.exec(r.stdout);
  assert.ok(at, r.stdout);
  assert.ok(Number(at[1]) >= 12 && Number(at[1]) < 60, 'never under the floor, always under the limit: ' + at[1]);
  assert.match(r.stdout, new RegExp(`RED-PROOF: TIMEOUT ✗ — break rule three off was stuck: still running after ${at[1]} s, twice the slowest finished run; it and every process it started were stopped`));
  assert.match(r.stdout, /BREAK ✓ rule one off/);
  assert.match(r.stdout, /BREAK ✓ rule two off/);
  assert.match(r.stdout, /RED-PROOF: NOT PROVED ✗ — 1 run\(s\) did not finish \(1 stuck at twice the slowest finished run\)/);
  assert.ok(took < 55000, `stopped as stuck, before the 60 s limit (took ${took} ms)`);
  assert.ok(gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the process the stuck run started is stopped too');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'r3.cjs')), rule, 'files restored');
});

test('without two finished red runs there is no stuck stop: only the time limit stops a hang', () => {
  const { repo, breaks } = fixture();
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'rule three off', file: 'r3.cjs', find: 'on: true', put: 'on: false', mustFail: ['rule three holds'] },
    { name: 'rule one off', file: 'r1.cjs', find: 'on: true', put: 'on: false', mustFail: ['rule one holds'] }]));
  const r = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '3', '--timeout-min', '0.15', '--', process.execPath, 'check.cjs']);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: TIMEOUT ✗ — break rule three off ran past 0\.15 min/);
  assert.doesNotMatch(r.stdout, /stuck/);
});

// A home folder with stand-in remote scripts: the preflight and the sync each note their call, then answer.
function fakeHome(preflight) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const dir = path.join(home, '.claude', 'scripts', 'remote');
  fs.mkdirSync(dir, { recursive: true });
  const calls = path.join(home, 'calls.txt');
  const note = (name) => `echo "${name} $*" >> '${calls.replace(/\\/g, '/')}'`;
  fs.writeFileSync(path.join(dir, 'remote-preflight.sh'), `#!/usr/bin/env bash\n${note('preflight')}\n${preflight}\n`);
  fs.writeFileSync(path.join(dir, 'remote-sync.sh'), `#!/usr/bin/env bash\n${note('sync')}\necho "FAILED: stand-in sync, the test stops here"\nexit 1\n`);
  return { home, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).map((l) => l.trim()) : []) };
}
function remoteFixture() {
  const f = fixture();
  for (const [k, v] of [['sanad.remoteHost', 'pc-test'], ['sanad.remoteRepo', 'C:/r/repo'], ['sanad.remoteDbContainer', 'eq-mysql']]) f.git('config', k, v);
  return f;
}
const dotnet = ['--', 'dotnet', 'test', 'A.Tests/A.Tests.csproj'];
// The test machine's PATH over ssh (2026-11-15: release 6 failed there): the WSL launcher in System32 is the first
// `bash`. The scripts must still run, through Git's own bash. Windows names the variable Path or PATH.
function wslFirst() {
  if (process.platform !== 'win32') return {};
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { [key]: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') + path.delimiter + process.env[key] };
}
const atHome = (home) => ({ HOME: home, USERPROFILE: home, ...wslFirst() });

test('a dotnet proof on the test machine checks the database first: a database that does not come up stops it before anything is sent', () => {
  const { repo, breaks } = remoteFixture();
  const h = fakeHome('echo "DB-DOWN eq-mysql is not healthy after 240 s"\nexit 7');
  const r = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, ...dotnet], atHome(h.home));
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: ENVIRONMENT ✗ — the database on the test machine is not ready \(DB-DOWN eq-mysql is not healthy after 240 s\); nothing ran/);
  assert.deepEqual(h.calls(), ['preflight --db'], 'no sync: nothing was sent');
});

test('a ready database lets the proof go on to the sync; a test machine that does not answer is REMOTE-DOWN', () => {
  const { repo, breaks } = remoteFixture();
  const ready = fakeHome('echo "READY pc-test docker 27.1 db eq-mysql healthy"');
  const r = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, ...dotnet], atHome(ready.home));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: database eq-mysql ready on pc-test/);
  assert.match(r.stdout, /the test machine was not synced — FAILED: stand-in sync/);
  assert.deepEqual(ready.calls(), ['preflight --db', 'sync']);
  const down = fakeHome('echo "REMOTE-DOWN pc-test does not answer"\nexit 4');
  const d = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, ...dotnet], atHome(down.home));
  assert.equal(d.status, 4, d.stdout + d.stderr);
  assert.match(d.stdout, /RED-PROOF: REMOTE-DOWN/);
  assert.deepEqual(down.calls(), ['preflight --db']);
});

test('no database check for a page proof, a warm-up, or a repository with no database container set', () => {
  const { repo, git, breaks } = remoteFixture();
  const h = fakeHome('echo "DB-DOWN never asked"\nexit 7');
  const page = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', 'node', 'node_modules/vitest/vitest.mjs', 'run', 'a.test.ts'], atHome(h.home));
  assert.equal(page.status, 2, page.stdout + page.stderr);
  const warm = run(['--repo', repo, '--warm', ...dotnet], atHome(h.home));
  assert.equal(warm.status, 2, warm.stdout + warm.stderr);
  git('config', '--unset', 'sanad.remoteDbContainer');
  const none = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, ...dotnet], atHome(h.home));
  assert.equal(none.status, 2, none.stdout + none.stderr);
  assert.deepEqual(h.calls(), ['sync', 'sync', 'sync'], 'each went straight to the sync');
});
