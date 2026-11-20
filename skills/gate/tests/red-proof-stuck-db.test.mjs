import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 2026-11-15 (role-sync task), two proof time losses:
// 1. One break kept a lock held, so its run waited the full 15 minutes while its peers had each finished in about
//    4. A red run still going at twice the slowest finished red run (never under a fifth of the limit) is stuck now.
const script = process.env.RED_PROOF_TEST_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
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
function fakeHome(preflight, sync = 'echo "FAILED: stand-in sync, the test stops here"\nexit 1') {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const dir = path.join(home, '.claude', 'scripts', 'remote');
  fs.mkdirSync(dir, { recursive: true });
  const calls = path.join(home, 'calls.txt');
  const note = (name) => `echo "${name} $*" >> '${calls.replace(/\\/g, '/')}'`;
  fs.writeFileSync(path.join(dir, 'remote-preflight.sh'), `#!/usr/bin/env bash\n${note('preflight')}\n${preflight}\n`);
  fs.writeFileSync(path.join(dir, 'remote-sync.sh'), `#!/usr/bin/env bash\n${note('sync')}\n${sync}\n`);
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

// 2026-11-20: skipped tests passed before Docker was ready. Run the real worker with a fake runner and fake SSH.
const transport = path.join(root, 'fake-transport.mjs');
fs.writeFileSync(transport, `
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawn, spawnSync = cp.spawnSync;
const dbDown = 'DOCKER-DOWN the container engine did not start';
const ready = 'READY pc-test docker 27.1 db eq-mysql healthy';
const scenario = process.env.PROOF_SCENARIO;
const events = process.env.PROOF_EVENTS;
const note = line => fs.appendFileSync(events, line + '\\n');
const isPreflight = (args) => args.some(a => a.includes('remote-preflight.sh'));
let db, plan, log;
const fake = () => Object.assign(new EventEmitter(), {
  stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
  finish(status, text) { this.stdout.end(text + '\\n'); this.stderr.end(); this.emit('close', status); }
});
cp.spawnSync = (file, args, opts) => {
  if (isPreflight(args)) return { status: 6, stdout: dbDown };
  if (args.some(a => a.includes('remote-sync.sh'))) {
    const id = ref => spawnSync('git', ['rev-parse', ref], { ...opts, encoding: 'utf8' }).stdout.trim();
    return { status: 0, stdout: 'SYNCED pc-test ' + id('HEAD') + ' tree ' + id('HEAD^{tree}') };
  }
  if (file === 'scp' && args[args.length - 2].includes('/proof-')) return { status: 0 };
  if (file === 'scp') {
    const name = args.find(arg => /^plan-.*\\.json$/.test(arg));
    plan = path.join(opts.cwd, name);
    log = path.join(opts.cwd, name.replace(/^plan-/, 'proof-').replace(/\\.json$/, '.log'));
  }
  if (file === 'ssh' || file === 'scp') return { status: 0 };
  return spawnSync(file, args, opts);
};
cp.spawn = (file, args, opts) => {
  if (isPreflight(args)) { note('preflight started'); db = fake(); return db; }
  if (file === 'dotnet') {
    const test = fake();
    setImmediate(() => {
      if (args.includes('--list-tests')) { note('compile'); test.finish(0, 'The following Tests are available:'); return; }
      const on = index => fs.readFileSync(path.join(opts.cwd, 'r' + index + '.cjs'), 'utf8').includes('true');
      if (!on(1) || !on(2)) {
        note(on(1) ? 'old' : 'break');
        if (scenario === 'break-survives') { test.finish(0, 'Passed! - Passed: 1, Skipped: 0, Total: 1'); return; }
        const reason = scenario === 'break-db-down' ? 'MySqlException: Unable to connect to any of the specified MySQL hosts' : 'AssertionError: expected true';
        test.finish(1, ' FAIL  src/a.test.cjs > rules > rule one holds\\n' + reason);
        return;
      }
      const readyNow = fs.readFileSync(events, 'utf8').includes('database ready');
      note(readyNow ? 'green ready' : 'green pending');
      if (scenario === 'code-failure' || (!readyNow && scenario === 'green-fails-first')) {
        test.finish(1, ' FAIL  src/a.test.cjs > rules > rule one holds\\nAssertionError: expected true'); return;
      }
      if (scenario === 'unknown-count' || scenario === 'ready-first') { test.finish(0, 'Tests 1 passed'); return; }
      if (scenario === 'only-skipped' || (scenario === 'skipped-then-ready' && !readyNow)) {
        test.finish(0, 'Passed! - Failed: 0, Passed: 0, Skipped: 1, Total: 1'); return;
      }
      if (scenario === 'vitest-count') { test.finish(0, '      Tests  1 passed | 0 skipped (1)'); return; }
      if (scenario === 'skipped-bang') {
        test.finish(0, 'Passed! - Failed: 0, Passed: 1, Skipped: 0, Total: 1\\nSkipped! - Failed: 0, Passed: 0, Skipped: 2, Total: 2'); return;
      }
      if (scenario === 'mixed-counts') {
        test.finish(0, 'Passed! - Passed: 1, Skipped: 0, Total: 1\\nPassed! - Passed: 0, Skipped: 1, Total: 1'); return;
      }
      test.finish(0, 'Passed! - Failed: 0, Passed: 1, Skipped: 0, Total: 1');
    });
    return test;
  }
  if (file !== 'ssh') return spawn(file, args, opts);
  const dbReady = () => { note('database ready'); db?.finish(0, ready); };
  if (scenario === 'ready-first') dbReady();
  if (['only-skipped', 'unknown-count', 'mixed-counts', 'skipped-bang', 'break-db-down'].includes(scenario)) db?.finish(6, dbDown);
  const session = spawn(process.execPath, [process.env.PROOF_SCRIPT, '--repo', process.env.PROOF_REPO, '--local',
    '--plan', plan, '--parallel', process.env.PROOF_PARALLEL, '--log', log, '--', 'dotnet', 'test', 'A.Tests/A.Tests.csproj'], opts);
  let stdout = '';
  session.stdout.on('data', chunk => {
    stdout += chunk;
    if (!stdout.includes('RED-PROOF-DB-WAIT:')) return;
    stdout = '';
    setImmediate(dbReady);
  });
  return session;
};
syncBuiltinESMExports();
`);
function fakeProof(scenario, parallel = 2, green = true) {
  const { repo, git, breaks } = remoteFixture();
  fs.writeFileSync(breaks, JSON.stringify(JSON.parse(fs.readFileSync(breaks, 'utf8')).slice(0, 1)));
  git('add', '.'); git('commit', '-qm', 'tests');
  fs.writeFileSync(path.join(repo, 'r2.cjs'), 'module.exports = { on: false };\n');
  git('add', 'r2.cjs'); git('commit', '-qm', 'buggy old code');
  const old = git('rev-parse', 'HEAD');
  git('revert', '--no-edit', old);
  const log = path.join(root, scenario + '.log');
  const events = path.join(root, path.basename(repo) + '.events');
  fs.writeFileSync(events, '');
  const result = run(['--repo', repo, '--base', 'HEAD', '--old', old, '--files', 'r2.cjs', '--breaks', breaks, ...(green ? ['--then-green'] : []), '--log', log, ...dotnet], {
    NODE_OPTIONS: '--import=' + pathToFileURL(transport).href,
    PROOF_SCENARIO: scenario, PROOF_SCRIPT: script, PROOF_REPO: repo, PROOF_EVENTS: events, PROOF_PARALLEL: String(parallel),
  });
  return { ...result, log: fs.readFileSync(log, 'utf8'), events: fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean) };
}

test('green with zero skips proves while the database is still starting', () => {
  for (const scenario of ['zero-skips', 'vitest-count']) {
    const r = fakeProof(scenario);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.events.indexOf('compile') < r.events.indexOf('green pending'), r.events.join(', '));
    assert.equal(r.events[0], 'preflight started');
    assert.equal(r.events.includes('database ready'), false);
    assert.deepEqual(r.events.filter(e => e === 'old' || e === 'break').sort(), ['break', 'old']);
    assert.match(r.stdout, /RED-PROOF: PROVED ✓/);
  }
});

test('skipped or unreadable test counts cannot prove anything while the database stays down', () => {
  for (const scenario of ['only-skipped', 'unknown-count', 'mixed-counts', 'skipped-bang']) {
    const r = fakeProof(scenario);
    assert.equal(r.status, 6, r.stdout + r.stderr);
    assert.match(r.stdout, /RED-PROOF: ENVIRONMENT ✗.*DOCKER-DOWN/);
    assert.doesNotMatch(r.stdout, /RED-PROOF: PROVED|RED-PROOF-DB-/);
    assert.match(r.log, /RED-PROOF: ENVIRONMENT ✗/);
    assert.doesNotMatch(r.log, /RED-PROOF: PROVED/);
    assert.ok(r.events.includes('green pending'));
    assert.ok(!r.events.includes('old') && !r.events.includes('break'));
  }
});

test('skipped or failed green reruns when the database becomes ready', () => {
  for (const [scenario, parallel] of [['skipped-then-ready', 2], ['green-fails-first', 1]]) {
    const r = fakeProof(scenario, parallel);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.events.filter(e => /^(green|database ready)/.test(e)), ['green pending', 'database ready', 'green ready']);
    assert.ok(r.events.indexOf('green ready') < Math.min(r.events.indexOf('old'), r.events.indexOf('break')));
    assert.match(r.stdout, /RED-PROOF: PROVED ✓/);
  }
});

test('a code failure after the database becomes ready stays a code failure', () => {
  const r = fakeProof('code-failure');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.events.filter(e => /^(green|database ready|old|break)/.test(e)), ['green pending', 'database ready', 'green ready']);
  assert.match(r.stdout, /RED-PROOF: NOT PROVED ✗ — the fixed tree fails/);
  assert.doesNotMatch(r.stdout, /RED-PROOF: ENVIRONMENT/);
});

test('after trusted green, code survival and database failures keep their own verdicts', () => {
  const survived = fakeProof('break-survives');
  assert.equal(survived.status, 1, survived.stdout + survived.stderr);
  assert.match(survived.stdout, /BREAK ✗ rule one off/);
  const down = fakeProof('break-db-down');
  assert.equal(down.status, 6, down.stdout + down.stderr);
  assert.match(down.stdout, /RED-PROOF: ENVIRONMENT ✗/);
  assert.doesNotMatch(down.stdout, /BREAK ✓|RED-PROOF: PROVED/);
});

test('a database ready before green keeps the existing judgment', () => {
  const r = fakeProof('ready-first');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.events.filter(e => e.startsWith('green')), ['green ready']);
  assert.match(r.stdout, /RED-PROOF: PROVED ✓/);
});

test('a proof without green waits before it starts the old and break runs', () => {
  const r = fakeProof('no-green', 1, false);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.events, ['preflight started', 'compile', 'database ready', 'old', 'break']);
});

test('a test machine that does not answer is REMOTE-DOWN', () => {
  const { repo, breaks } = remoteFixture();
  const message = 'echo "REMOTE-DOWN pc-test does not answer"\nexit 4';
  const down = fakeHome(message, message);
  const d = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, ...dotnet], atHome(down.home));
  assert.equal(d.status, 4, d.stdout + d.stderr);
  assert.match(d.stdout, /RED-PROOF: REMOTE-DOWN/);
  assert.ok(down.calls().length > 0, 'the proof checks whether the machine answers');
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
