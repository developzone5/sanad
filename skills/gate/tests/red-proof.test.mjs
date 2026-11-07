import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');

// A repo whose committed code has the bug (value 1); the working tree holds the fix (value 2) plus
// a test that passes only with the fix.
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-tests-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Red proof fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 1;\r\n');
  git('add', 'app.cjs'); git('commit', '-qm', 'buggy');
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 2; // fixed\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'process.exit(require("./app.cjs") === 2 ? 0 : 1);\n');
  return { repo, git };
}
// The fixtures must not see this machine's git settings (a test machine there sends runs away).
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-git-')), 'config');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', ...env } });

test('a test that fails on the old code is RED, and the fix comes back byte for byte', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const result = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RED-PROOF: RED ✓/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
});

test('a test that also passes on the old code is NOT RED (exit 1), files restored', () => {
  const { repo } = fixture();
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'process.exit(0);\n');
  const result = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /NOT RED ✗/);
  assert.match(fs.readFileSync(path.join(repo, 'app.cjs'), 'utf8'), /fixed/);
});

test('a fix file that did not exist on the old code is removed for the run and put back', () => {
  const { repo } = fixture();
  fs.writeFileSync(path.join(repo, 'helper.cjs'), 'module.exports = "new";\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'require("node:fs").existsSync(__dirname + "/helper.cjs") ? process.exit(0) : process.exit(1);\n');
  const result = run(['--repo', repo, '--old', 'HEAD', '--files', 'helper.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(repo, 'helper.cjs'), 'utf8'), 'module.exports = "new";\n');
});

test('usage errors and unknown refs exit 2 and change nothing', () => {
  const { repo } = fixture();
  assert.equal(run(['--repo', repo, '--files', 'app.cjs', '--', process.execPath, 'check.cjs']).status, 2);
  assert.equal(run(['--repo', repo, '--old', 'no-such-ref', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']).status, 2);
  assert.match(fs.readFileSync(path.join(repo, 'app.cjs'), 'utf8'), /fixed/);
});

const breakArgs = (repo, find, put) => ['--repo', repo, '--break', 'app.cjs', '--find', find, '--put', put, '--', process.execPath, 'check.cjs'];

test('--break: a test that needs the line is RED, and the file comes back byte for byte', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const result = run(breakArgs(repo, 'exports = 2', 'exports = 3'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RED ✓ — the test fails with app\.cjs broken/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
});

test('--break: a test that ignores the line is NOT RED (exit 1), file restored', () => {
  const { repo } = fixture();
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'process.exit(0);\n');
  const result = run(breakArgs(repo, 'exports = 2', 'exports = 3'));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /NOT RED ✗/);
  assert.match(fs.readFileSync(path.join(repo, 'app.cjs'), 'utf8'), /exports = 2/);
});

test('--break: text that matches zero or two times exits 2 and changes nothing', () => {
  const { repo } = fixture();
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 2; // 2\n');
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  assert.equal(run(breakArgs(repo, 'not in the file', 'x')).status, 2);
  assert.equal(run(breakArgs(repo, '2', '3')).status, 2);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
});

test('--break: a test command that cannot start still restores the file', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const result = run(['--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', '--', 'no-such-program-here']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
});

// 2026-11-06: red runs mixed real failures with broken tests. Each failing test is now named with its
// reason; a setup failure (element not found, type or build error, timeout) is exit 3, not a red.
function runnerOutput(repo, lines) {
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const fixed = require("./app.cjs") === 2;',
    `if (!fixed) { console.log(${JSON.stringify(lines.join('\n'))}); process.exit(1); }`,
    'process.exit(0);', ''].join('\n'));
}

test('an assertion failure is a real red, and each failing test is named', () => {
  const { repo } = fixture();
  runnerOutput(repo, [' FAIL  src/a.test.tsx > list > shows the message once', 'AssertionError: expected 2 to be 1 // Object.is equality', ' FAIL  src/a.test.tsx > list > clears it', 'AssertionError: expected [ 1 ] to deeply equal []']);
  const result = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /✓ assert\s+src\/a\.test\.tsx > list > shows the message once — AssertionError: expected 2 to be 1/);
  assert.match(result.stdout, /RED ✓ .*2 of 2 failing test\(s\) by an assertion/);
});

test('a test that fails because an element is missing is SETUP (exit 3), not proof', () => {
  const { repo } = fixture();
  runnerOutput(repo, [' FAIL  src/a.test.tsx > list > shows the message once', 'AssertionError: expected 2 to be 1', ' FAIL  src/a.test.tsx > list > ticks a type', 'TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "PDF"']);
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const result = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 3, result.stdout);
  assert.match(result.stdout, /✗ setup\s+src\/a\.test\.tsx > list > ticks a type/);
  assert.match(result.stdout, /SETUP ✗ — 1 failed for a setup reason/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before, 'files are restored on SETUP too');
});

test('a timeout and a dotnet failure are read too; a build error with no test is SETUP', () => {
  const { repo } = fixture();
  runnerOutput(repo, ['  Failed Api.Tests.HomeworkTests.LateAtTheMinute [42 ms]', '  Error Message:', '   Assert.Equal() Failure: Values differ', ' FAIL  src/b.test.ts > export > writes the file', 'Error: Test timed out in 5000ms.']);
  const mixed = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(mixed.status, 3, mixed.stdout);
  assert.match(mixed.stdout, /✓ assert\s+Api\.Tests\.HomeworkTests\.LateAtTheMinute — Assert\.Equal\(\) Failure/);
  assert.match(mixed.stdout, /✗ setup\s+src\/b\.test\.ts > export > writes the file — Error: Test timed out/);
  runnerOutput(repo, ['Build FAILED.', 'Program.cs(3,1): error CS1002: ; expected']);
  assert.equal(run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']).status, 3);
  runnerOutput(repo, ['some runner we do not read']);
  const unread = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(unread.status, 0, 'an unknown runner keeps the old exit-code rule');
  assert.match(unread.stdout, /failure reasons not read from this runner/);
});

// 2026-11-06: vitest lists tests that fail the same way together, one FAIL line each, above one
// shared error; each of them gets that error's reason.
test('tests listed together above one shared error each get its reason', () => {
  const { repo } = fixture();
  runnerOutput(repo, [' FAIL  src/a.test.tsx > form > after Save draft, it appears once', ' FAIL  src/a.test.tsx > form > after Next, it appears once', '', 'AssertionError: expected 2 to be 1 // Object.is equality', ' FAIL  src/a.test.tsx > form > ticks a type', 'TypeError: Cannot read properties of undefined']);
  const result = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.match(result.stdout, /✓ assert\s+src\/a\.test\.tsx > form > after Save draft, it appears once — AssertionError: expected 2 to be 1/);
  assert.match(result.stdout, /✓ assert\s+src\/a\.test\.tsx > form > after Next, it appears once — AssertionError: expected 2 to be 1/);
  assert.match(result.stdout, /✗ setup\s+src\/a\.test\.tsx > form > ticks a type — TypeError/);
  assert.doesNotMatch(result.stdout, /\? other/);
});

// 2026-11-07: a "nothing happens" check passed review three rounds in a row that no run had ever
// seen fail. --breaks breaks the rule under test and names the tests that must then fail.
function breakFixture() {
  const { repo, git } = fixture();
  process.env.SANAD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-state-'));
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = { blocks: true };\n');
  git('add', 'rule.cjs'); git('commit', '-qm', 'rule');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.test.cjs'), '// the tests\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const blocks = require("./rule.cjs").blocks;',
    'const fails = [];',
    'if (!blocks) fails.push(" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0");',
    'if (require("./app.cjs") !== 2) fails.push(" FAIL  src/a.test.cjs > form > shows it once", "AssertionError: expected 2 to be 1");',
    'if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  const breaks = path.join(repo, '..', path.basename(repo) + '-breaks.json');
  return { repo, breaks };
}
const writeBreaks = (file, mustFail) => fs.writeFileSync(file, JSON.stringify([{ name: 'the rule does not block', file: 'rule.cjs', find: 'blocks: true', put: 'blocks: false', mustFail }]));

test('--breaks: the named tests fail under the break, the old code is red, the fix is green, files restored', async () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  const rule = fs.readFileSync(path.join(repo, 'rule.cjs'));
  const result = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /RED-PROOF: RED ✓/);
  assert.match(result.stdout, /BREAK ✓ the rule does not block: all 1 named test\(s\) fail/);
  assert.match(result.stdout, /GREEN ✓/);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓ — red on the old code, 1 break\(s\) caught, green on the fix/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'rule.cjs')), rule);
  const { readRecord, testFileHashes, provesCurrent } = await import('../scripts/proof-record.mjs');
  const record = readRecord(repo);
  assert.equal(record.breaks, 1);
  assert.ok(provesCurrent(record, testFileHashes(repo, ['src/a.test.cjs'])), 'the record covers the test file as it is now');
  fs.appendFileSync(path.join(repo, 'src/a.test.cjs'), '// edited after the proof\n');
  assert.ok(!provesCurrent(record, testFileHashes(repo, ['src/a.test.cjs'])), 'an edit after the proof voids it');
});

test('--breaks: a named test that still passes under the break is reported and fails the proof', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing', 'shows it once']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /BREAK ✗ the rule does not block: still pass \(or not seen failing\): shows it once/);
  assert.match(result.stdout, /NOT PROVED ✗/);
});

test('--then-green: a test that fails on the fixed tree fails the proof', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 3;\n');
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /GREEN ✗/);
});

test('--breaks: a break whose text is not found once, or with no mustFail list, changes nothing', () => {
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'x', file: 'rule.cjs', find: 'not there', put: 'y', mustFail: ['a'] }]));
  assert.equal(run(['--repo', repo, '--breaks', breaks, '--', process.execPath, 'check.cjs']).status, 2);
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'x', file: 'rule.cjs', find: 'blocks: true', put: 'y' }]));
  assert.equal(run(['--repo', repo, '--breaks', breaks, '--', process.execPath, 'check.cjs']).status, 2);
});

// 2026-11-07: eleven runs one after another took 2 minutes. Each run now has its own copy, several
// at a time, and the working folder is never touched.
test('--parallel: every run in its own copy; the folder is untouched and every copy is removed', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  const before = fs.readFileSync(path.join(repo, 'rule.cjs'));
  const result = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--parallel', '3', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /3 run\(s\), 3 at a time, each in its own copy/);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'rule.cjs')), before);
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(worktrees.length, 1, 'every temporary copy is removed: ' + worktrees.join(' | '));
});

test('a test machine in git config sends the run there; --local keeps it here', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  execFileSync('git', ['config', 'sanad.remoteHost', 'no-such-host'], { cwd: repo });
  const away = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', process.execPath, 'check.cjs']);
  assert.equal(away.status, 2, away.stdout);
  assert.match(away.stdout, /sanad\.remoteRepo is not; set it, or run with --local/);
  const here = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--local', '--', process.execPath, 'check.cjs']);
  assert.equal(here.status, 0, here.stdout);
});
