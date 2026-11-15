import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { greenOf } from '../scripts/run-record.mjs';

// 2026-11-15: a proof run in the background with its output sent to a file showed the stop hook nothing, so its
// passing green run never counted as a test run. Each --then-green run now leaves a run record when it ends
// (run-record.mjs); the stop hook reads it (hooks/tests/stop-gate-red-proof.test.mjs). These tests pin what it holds.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-run-record-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));

let n = 0;
// A repo whose committed code is fixed (app.cjs = 2), with a test (check.cjs) and a state folder of its own.
function fixture(check) {
  const dir = path.join(root, 'case' + (++n)), repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), check || 'if (require("./app.cjs") !== 2) { console.log(" FAIL  src/app.test.cjs > app > is fixed\\nAssertionError: expected 3 to be 2"); process.exit(1); }\n');
  git('add', '.'); git('commit', '-qm', 'fixed');
  const runs = path.join(state, 'proof', 'runs');
  const records = () => (fs.existsSync(runs) ? fs.readdirSync(runs).sort() : []).map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(runs, f), 'utf8')) }));
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state } });
  return { repo, git, runs, records, run };
}
const breakArgs = (repo, ...extra) => ['--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', ...extra, '--', process.execPath, 'check.cjs'];

test('a --then-green run leaves one record: its arguments, times, exit, green passed, and the same tree at its start and end', () => {
  const f = fixture();
  const args = breakArgs(f.repo, '--then-green');
  const before = Date.now();
  const r = f.run(args);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /GREEN ✓/);
  const list = f.records();
  assert.equal(list.length, 1);
  const rec = list[0];
  assert.deepEqual(rec.argv, args, 'the arguments exactly as given');
  assert.equal(rec.exit, 0);
  assert.equal(rec.green, 'passed');
  assert.match(rec.treeStart, /^[0-9a-f]{40,64}$/);
  assert.equal(rec.treeEnd, rec.treeStart, 'the break was put back: the tree at the end is the tree at the start');
  assert.match(rec.verdict, /^RED-PROOF: RED ✓/);
  assert.ok(Date.parse(rec.startedAt) >= before - 1000 && Date.parse(rec.endedAt) >= Date.parse(rec.startedAt) && Date.parse(rec.endedAt) <= Date.now());
  assert.equal(rec.file, `${Date.parse(rec.startedAt)}-${rec.file.split('-')[1]}`, 'named by its start time and process');
  assert.equal(f.git('status', '--porcelain'), '', 'the record is kept outside the repository');
});

test('NOT RED after a passing green run: green passed, exit 1; a failing green run: green failed', () => {
  const notRed = fixture('process.exit(0);\n');
  const a = notRed.run(breakArgs(notRed.repo, '--then-green'));
  assert.equal(a.status, 1, a.stdout);
  assert.match(a.stdout, /NOT RED ✗/);
  assert.deepEqual(notRed.records().map((r) => [r.exit, r.green]), [[1, 'passed']]);
  const red = fixture('console.log(" FAIL  src/app.test.cjs > app > is fixed\\nAssertionError: expected 2 to be 5"); process.exit(1);\n');
  const b = red.run(breakArgs(red.repo, '--then-green'));
  assert.equal(b.status, 1, b.stdout);
  assert.match(b.stdout, /GREEN ✗/);
  const [rec] = red.records();
  assert.deepEqual([rec.exit, rec.green, rec.treeEnd], [1, 'failed', ''], 'no end tree is read for a green that failed');
});

test('a run without --then-green, or a usage error, leaves no green; only --then-green runs write a record', () => {
  const f = fixture();
  assert.equal(f.run(breakArgs(f.repo)).status, 0);
  assert.equal(f.records().length, 0, 'no green asked: no record');
  const bad = f.run(['--repo', f.repo, '--break', 'app.cjs', '--find', 'not there', '--put', 'x', '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(bad.status, 2);
  const [rec] = f.records();
  assert.deepEqual([rec.exit, rec.green], [2, 'none']);
});

test('the tree changed while the run ran (the test wrote a file): the end tree differs', () => {
  const f = fixture('require("node:fs").writeFileSync(__dirname + "/touched-" + Date.now() + ".txt", "x");\n');
  const r = f.run(breakArgs(f.repo, '--then-green'));
  assert.equal(r.status, 1, r.stdout);   // the test ignores app.cjs: NOT RED, after a passing green run
  const [rec] = f.records();
  assert.equal(rec.green, 'passed');
  assert.notEqual(rec.treeEnd, rec.treeStart);
});

test('with --log, the start tree is the log\'s own; a test machine\'s plan run writes no record', () => {
  const f = fixture();
  const log = path.join(root, 'proof-' + n + '.log');
  assert.equal(f.run(breakArgs(f.repo, '--then-green', '--log', log)).status, 0);
  const head = /^RED-PROOF-LOG: tree ([0-9a-f]{40,64}) /.exec(fs.readFileSync(log, 'utf8'));
  assert.ok(head, 'the log names its tree');
  assert.equal(f.records()[0].treeStart, head[1]);
  // The run on the test machine gets its runs from a plan; the machine that asked writes the record.
  const g = fixture();
  const plan = path.join(root, 'plan-' + n + '.json');
  fs.writeFileSync(plan, JSON.stringify({ green: true, breaks: [{ name: 'b', file: 'app.cjs', find: 'exports = 2', put: 'exports = 3', mustFail: ['is fixed'] }], commit: g.git('rev-parse', 'HEAD'), testFiles: [], old: [] }));
  const p = g.run(['--repo', g.repo, '--local', '--plan', plan, '--parallel', '1', '--base', 'HEAD', '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(p.status, 0, p.stdout);
  assert.match(p.stdout, /GREEN ✓/);
  assert.equal(g.records().length, 0);
});

test('records older than 7 days go when a new one is written', () => {
  const f = fixture();
  fs.mkdirSync(f.runs, { recursive: true });
  const old = `${Date.now() - 8 * 24 * 3600 * 1000}-1.json`, recent = `${Date.now() - 3 * 24 * 3600 * 1000}-1.json`;
  for (const name of [old, recent]) fs.writeFileSync(path.join(f.runs, name), '{}');
  assert.equal(f.run(breakArgs(f.repo, '--then-green')).status, 0);
  const names = fs.readdirSync(f.runs);
  assert.ok(!names.includes(old), 'the old record is gone');
  assert.ok(names.includes(recent), 'a recent one stays');
  assert.equal(names.length, 2);
});

test('greenOf: green passed only with GREEN ✓, no GREEN ✗, no stop of another kind, and exit 0 or 1', () => {
  const ok = ['  GREEN ✓ the tests pass on the fixed tree'];
  assert.equal(greenOf([...ok, 'RED-PROOF: PROVED ✓ — 1 break(s) caught, green on the fix'], 0), 'passed');
  assert.equal(greenOf([...ok, 'RED-PROOF: NOT PROVED ✗ — see the lines above'], 1), 'passed', 'a proof that did not hold still ran green');
  assert.equal(greenOf(['  GREEN ✗ the tests fail on the fixed tree', 'RED-PROOF: NOT PROVED ✗'], 1), 'failed');
  assert.equal(greenOf(['RED-PROOF: SETUP ✗ — the fixed tree does not compile'], 3), 'none');
  for (const [line, code] of [['RED-PROOF: TIMEOUT ✗ — break ran past 15 min', 5], ['RED-PROOF: ENVIRONMENT ✗ — the test machine failed', 6],
    ['RED-PROOF: REMOTE-DOWN — the test machine does not answer', 4], ['RED-PROOF: RESTORE FAILED — restore mismatch', 2], ['RED-PROOF: failed — boom', 2]]) {
    assert.equal(greenOf([...ok, line], code), 'none', line);
  }
  assert.equal(greenOf(ok, 2), 'none', 'exit 2 after green: the run was stopped');
  assert.equal(greenOf(ok, 5), 'none');
  assert.equal(greenOf(['  ✓ assert  GREEN ✓ in a test title'], 0), 'none', 'only a line of its own');
});
