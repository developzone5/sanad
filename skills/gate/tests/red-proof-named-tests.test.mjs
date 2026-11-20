// 2026-11-19: a green run whose filter matched nothing exited 0 and read "GREEN ✓ the tests pass on the fixed tree".
// A passing run that ran no test is never green: it reads "GREEN ✗ no test ran", the red runs are skipped and the
// proof is NOT PROVED. A break run is narrowed to the tests it names (selectCommand) when the runner is known;
// a runner it does not know gets the full command (tested here).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ranNoTest } from '../scripts/red-proof.mjs';
import { greenOf } from '../scripts/run-record.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'red-proof.mjs');
const roots = [];
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-named-git-')), 'config');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const gitEnv = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const node = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...gitEnv, ...env } });
after(() => {
  for (const root of roots) {
    node(script, ['--repo', path.join(root, 'repo'), '--drop-copies']);
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
});

const NONE = 'No test matches the given testcase filter `FullyQualifiedName~Nothing` in C:\\x\\Tests.dll';
// The runner: the filter "Nothing" matches no test (exit 0, as dotnet test does); "Some" matches none in one
// project and three in another. Each run notes its arguments in ran.txt, outside the repository.
const CHECK = [
  'const fs = require("node:fs"), nl = String.fromCharCode(10);',
  'fs.appendFileSync(process.env.RAN_MARKER, process.argv.slice(2).join(" ") + nl);',
  `const none = ${JSON.stringify(NONE)};`,
  'if (process.argv.includes("Nothing")) { console.log(none); process.exit(0); }',
  'if (!require("./rule.cjs").cleans) { console.log(" FAIL  src/clean.test.cjs > clean > cleans the list" + nl + "AssertionError: expected 2 to be 1"); process.exit(1); }',
  'if (process.argv.includes("Some")) console.log(none + nl + "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 1 s");', ''].join('\n');
const CLEAN_JS = ["describe('clean', () => {", "  it('cleans the list', () => {", "    expect(list).toEqual(['a']);", '  });', '});', ''].join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-named-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...gitEnv } }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = { cleans: true };\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), CHECK);
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'src', 'clean.test.cjs'), CLEAN_JS);
  const marker = path.join(root, 'ran.txt'), breaks = path.join(root, 'breaks.json'), state = path.join(root, 'state');
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'cleans broken', file: 'rule.cjs', find: 'cleans: true', put: 'cleans: false', mustFail: ['cleans the list'] }]));
  const proof = (filter, extra = []) => node(script, ['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', ...extra, '--', process.execPath, 'check.cjs', '--filter', filter],
    { RAN_MARKER: marker, SANAD_STATE_DIR: state });
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
  const runRecords = () => { const dir = path.join(state, 'proof', 'runs'); return fs.existsSync(dir) ? fs.readdirSync(dir).map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))) : []; };
  return { repo, proof, ran, runRecords };
}

for (const parallel of ['1', '2']) {
  test(`a passing green run that ran no test is GREEN ✗, never green: NOT PROVED, exit 1, no red run started (--parallel ${parallel})`, () => {
    const f = fixture();
    const rule = fs.readFileSync(path.join(f.repo, 'rule.cjs'));
    const r = f.proof('Nothing', ['--parallel', parallel]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^\s*GREEN ✗ no test ran on the fixed tree \(exit 0: "No test matches the given testcase filter"\)/m);
    assert.match(r.stdout, /RED-PROOF: NOT PROVED ✗ — the green run ran no test/);
    assert.doesNotMatch(r.stdout, /GREEN ✓|PROVED ✓|BREAK ✓/);
    assert.equal(f.ran(), 1, 'only the green run started');
    assert.deepEqual(fs.readFileSync(path.join(f.repo, 'rule.cjs')), rule, 'files untouched');
    const records = f.runRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].green, 'failed', 'the stop hook reads this green run as failed');
  });
}

test('a solution run where one project has no matching test and another ran tests is a real green run', () => {
  const f = fixture();
  const r = f.proof('Some', ['--parallel', '1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /GREEN ✓ the tests pass on the fixed tree/);
  assert.match(r.stdout, /RED-PROOF: PROVED ✓/);
});

test('ranNoTest: only a passing run whose runner says no test ran and shows no test that ran', () => {
  assert.equal(ranNoTest({ status: 0, stdout: NONE + '\n', stderr: '' }), true);
  assert.equal(ranNoTest({ status: 0, stdout: '', stderr: 'No test is available in C:\\x\\Tests.dll\n' }), true);
  assert.equal(ranNoTest({ status: 0, stdout: NONE + '\nPassed!  - Failed: 0, Passed: 3, Skipped: 0, Total: 3\n', stderr: '' }), false);
  assert.equal(ranNoTest({ status: 0, stdout: ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n', stderr: '' }), false);
  assert.equal(ranNoTest({ status: 1, stdout: 'No test files found, exiting with code 1\n', stderr: '' }), false, 'a failing run is read as before');
  assert.equal(ranNoTest({ status: 0, stdout: NONE, stderr: '', timedOut: true }), false);
  assert.equal(ranNoTest(undefined), false);
  assert.equal(greenOf(['  GREEN ✗ no test ran on the fixed tree (exit 0: "No tests found")'], 1), 'failed');
});

test('a runner selectCommand does not know gets the full command on every run (the fallback), and the proof is PROVED', () => {
  const f = fixture();
  const r = f.proof('Some', ['--parallel', '2']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = fs.readFileSync(path.join(path.dirname(f.repo), 'ran.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2 && lines.every(l => l === 'check.cjs --filter Some' || l === '--filter Some'), 'every run has the same arguments: ' + lines.join(' | '));
});

test('a new test named by a caught break gets a TEST ✓ row (break <name>)', () => {
  const f = fixture();
  const r = f.proof('Some', ['--parallel', '1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /TEST ✓ cleans the list: break cleans broken/);
});
