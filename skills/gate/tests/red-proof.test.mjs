import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');

// Every fixture's kept copies (--parallel keeps one copy per slot for the next proof) are removed
// when the file is done.
const fixtures = [];
after(() => { for (const repo of fixtures) run(['--repo', repo, '--drop-copies']); });

// A repo whose committed code has the bug (value 1); the working tree holds the fix (value 2) plus
// a test that passes only with the fix.
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-tests-'));
  fixtures.push(repo);
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
// A proof that hangs is stopped here after 2 minutes, so a hang fails the test instead of the suite.
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', ...env } });

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
test('--parallel: every run in its own copy; the folder is untouched and no worktree is left behind', () => {
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

// 2026-11-07: a test that crashed because the break removed its element stopped the whole proof as a
// "setup" failure, twice. Under a break, any failure of a named test catches the break.
test('--breaks: a named test that crashes under the break catches it; the proof goes on', () => {
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const blocks = require("./rule.cjs").blocks;',
    'if (!blocks) { console.log([" FAIL  src/a.test.cjs > form > saves nothing", "TypeError: Cannot read properties of null"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  writeBreaks(breaks, ['saves nothing']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /BREAK ✓ the rule does not block: all 1 named test\(s\) fail/);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓/);
});

// 2026-11-07: the CI machine names its temp folder with a short 8.3 name (RUNNER~1) while git names it
// in full, so the proof record was written under one name and looked up under the other. A folder link
// gives the same two spellings here.
test('the proof record is found under any spelling of the same folder', async () => {
  const { repo } = breakFixture();
  const alias = repo + '-alias';
  fs.symlinkSync(repo, alias, 'junction');
  try {
    const { writeRecord, readRecord } = await import('../scripts/proof-record.mjs');
    writeRecord(alias, { ok: true, breaks: 1, files: { 'src/a.test.cjs': 'x' } });
    assert.equal(readRecord(repo)?.breaks, 1, 'written through the link, read through the real path');
  } finally {
    fs.unlinkSync(alias);
  }
});

// 2026-11-08: a rebase rewrote a proven test file with CRLF line endings, and pre-review called its
// proven checks unproven. The proof record now hashes the text with line endings made the same.
test('a test file rewritten with CRLF line endings keeps its proof', async () => {
  const { testFileHashes } = await import('../scripts/proof-record.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-crlf-'));
  fs.writeFileSync(path.join(dir, 'a.test.ts'), 'one\ntwo\n');
  const lf = testFileHashes(dir, ['a.test.ts']);
  fs.writeFileSync(path.join(dir, 'a.test.ts'), 'one\r\ntwo\r\n');
  assert.deepEqual(testFileHashes(dir, ['a.test.ts']), lf, 'only the line endings changed');
  fs.writeFileSync(path.join(dir, 'a.test.ts'), 'one\r\nthree\r\n');
  assert.notDeepEqual(testFileHashes(dir, ['a.test.ts']), lf, 'a real edit still voids the proof');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-09: 7 copies each restored and built the whole .NET solution (5 to 13 minutes). A build at
// another folder path always recompiles everything (MSBuild hashes the full reference paths), so the
// copies stay at fixed places between proofs and keep their build outputs; each is reset to the
// tree under test, so nothing from one proof reaches the next.
test('--parallel: copies are kept for the next proof with their build outputs, and nothing else leaks into it', () => {
  const { repo, breaks } = breakFixture();
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'obj/\n');
  git('add', '.gitignore'); git('commit', '-qm', 'ignore build output');
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const fs = require("node:fs");',
    'console.log("WARM=" + fs.existsSync("obj/warm") + " STALE=" + fs.existsSync("stale.cjs"));',
    'fs.mkdirSync("obj", { recursive: true }); fs.writeFileSync("obj/warm", "1");',
    'if (!require("./rule.cjs").blocks) { console.log([" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'stale.cjs'), '// only in the first proof\n');
  writeBreaks(breaks, ['saves nothing']);
  const proof = (n) => {
    const log = path.join(repo, '..', path.basename(repo) + `-${n}.log`);
    const r = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '2', '--log', log, '--', process.execPath, 'check.cjs']);
    assert.equal(r.status, 0, r.stdout);
    return fs.readFileSync(log, 'utf8');
  };
  const first = proof(1);
  assert.equal((first.match(/WARM=false STALE=true/g) || []).length, 2, first);
  fs.rmSync(path.join(repo, 'stale.cjs'));
  const second = proof(2);
  assert.equal((second.match(/WARM=true STALE=false/g) || []).length, 2, 'warm outputs kept, the removed file gone: ' + second);
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split(/\r?\n/).length, 1);
  const drop = run(['--repo', repo, '--drop-copies']);
  assert.equal(drop.status, 0, drop.stdout);
  assert.match(drop.stdout, /removed 2 kept cop/);
  assert.equal((proof(3).match(/WARM=false/g) || []).length, 2, 'after --drop-copies every copy starts cold');
});

// 2026-11-09: a test file with a missing `using` made all 6 copies fail as SETUP after full builds
// (4 minutes lost). A `dotnet test` command is compiled once, on the fixed tree, before any copy runs.
test('the compile check of a dotnet test command is the same command with --list-tests; other runners have none', async () => {
  const { compileCheckCommand } = await import('../scripts/red-proof.mjs');
  assert.deepEqual(compileCheckCommand(['dotnet', 'test', 'A.Tests/A.Tests.csproj', '--filter', 'FullyQualifiedName~Late']),
    ['dotnet', 'test', 'A.Tests/A.Tests.csproj', '--filter', 'FullyQualifiedName~Late', '--list-tests']);
  assert.deepEqual(compileCheckCommand(['C:/Program Files/dotnet/dotnet.exe', 'test', 'A.csproj', '--', 'RunConfiguration.MaxCpuCount=1']),
    ['C:/Program Files/dotnet/dotnet.exe', 'test', 'A.csproj', '--list-tests', '--', 'RunConfiguration.MaxCpuCount=1']);
  assert.equal(compileCheckCommand([process.execPath, 'node_modules/vitest/vitest.mjs', 'run']), null);
  assert.equal(compileCheckCommand(['dotnet', 'build']), null);
});

const dotnetVersion = (() => { try { return execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
test('a dotnet test command that does not compile stops at once with the compiler lines (SETUP), before any copy runs', { skip: !dotnetVersion && 'dotnet is not installed' }, () => {
  const { repo, breaks } = breakFixture();
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.mkdirSync(path.join(repo, 'lib'));
  // IsTestProject: `dotnet test` skips a plain class library without building it (real test projects
  // get this from Microsoft.NET.Test.Sdk). No package, so nothing is downloaded.
  fs.writeFileSync(path.join(repo, 'lib/Lib.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net${dotnetVersion.split('.')[0]}.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n`);
  fs.writeFileSync(path.join(repo, 'lib/Class1.cs'), 'namespace Lib; public class Class1 { }\n');
  git('add', 'lib'); git('commit', '-qm', 'lib');
  fs.writeFileSync(path.join(repo, 'lib/Class1.cs'), 'namespace Lib; public class Class1 { [Fact] public void T() { } }\n');
  writeBreaks(breaks, ['saves nothing']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '2', '--', 'dotnet', 'test', 'lib/Lib.csproj']);
  assert.equal(result.status, 3, result.stdout);
  assert.match(result.stdout, /error CS0246: The type or namespace name 'Fact/);
  assert.match(result.stdout, /SETUP ✗ — the fixed tree does not compile/);
  assert.doesNotMatch(result.stdout, /run\(s\), \d+ at a time/, 'no run starts');
});

// 2026-11-09: `cmd.exe /c <wrapper>.cmd` typed in Git Bash hung for 25 minutes with nothing started.
// Git Bash turns /c into C:/, so cmd.exe opened an interactive prompt, and each run's open input pipe
// let that prompt wait for ever.
test('cmd.exe without /c is refused at once (Git Bash turns /c into C:/), before anything runs', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', 'cmd.exe', 'C:/', 'C:/Users/x/wrapper.cmd']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /cmd\.exe without \/c/);
  assert.match(result.stdout, /\/\/c/);
});

test('a run that waits for typed input gets none (no open input pipe), so it cannot hang', () => {
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  if (!require("./rule.cjs").blocks) { console.log([" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0"].join(String.fromCharCode(10))); process.exit(1); }',
    '  process.exit(0);',
    '});', ''].join('\n'));
  writeBreaks(breaks, ['saves nothing']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '2', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout + (result.error ? ' ' + result.error.message : ''));
  assert.match(result.stdout, /RED-PROOF: PROVED ✓/);
});

// 2026-11-09: opt-in MySQL tests need EDUQUEST_TEST_MYSQL, a connection string with a password.
// --test-env (a file on the machine that runs the tests) gives every run its variables, and their
// values never reach the output or the log.
function envFixture() {
  const { repo, breaks } = breakFixture();
  // A new random password on every run: the hider must hide whatever the file holds, and no fixed
  // password sits in the repository for the secret scanner to stop.
  const secret = crypto.randomBytes(9).toString('hex');
  const value = `Server=db;Password=${secret}`;
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const db = process.env.EQ_PROOF_DB || "";',
    'console.log("connecting with " + db);',
    'const fails = [];',
    `if (db !== ${JSON.stringify(value)} || process.env.EQ_OTHER !== "plain") fails.push(" FAIL  src/a.test.cjs > db > has the env", "AssertionError: expected the env");`,
    'if (!require("./rule.cjs").blocks) fails.push(" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0");',
    'if (require("./app.cjs") !== 2) fails.push(" FAIL  src/a.test.cjs > form > shows it once", "AssertionError: expected 2 to be 1");',
    'if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  writeBreaks(breaks, ['saves nothing']);
  const env = path.join(repo, '..', path.basename(repo) + '.env');
  fs.writeFileSync(env, `# the test database\r\nEQ_PROOF_DB="${value}"\r\n\r\nexport EQ_OTHER=plain\r\n`);
  return { repo, breaks, env, secret };
}

test('--test-env: every run gets the variables, in copies and in the folder; values never reach the output or the log', () => {
  const { repo, breaks, env, secret } = envFixture();
  const log = path.join(repo, '..', path.basename(repo) + '-env.log');
  for (const parallel of ['2', '1']) {
    const result = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--parallel', parallel, '--test-env', env, '--log', log, '--', process.execPath, 'check.cjs']);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /RED-PROOF: PROVED ✓/);
    assert.match(result.stdout, /environment from .*: EQ_PROOF_DB, EQ_OTHER \(values hidden\)/);
    assert.ok(!(result.stdout + result.stderr).includes(secret), 'the output hides the value');
    const text = fs.readFileSync(log, 'utf8');
    assert.ok(!text.includes(secret), 'the log hides the value');
    assert.match(text, /connecting with \*\*\*/, 'a test that prints the value shows *** instead');
  }
});

test('--test-env: a missing file, or a line that is not KEY=VALUE, stops before any run without showing the line', () => {
  const { repo, breaks, env } = envFixture();
  fs.writeFileSync(env, 'EQ_PROOF_DB=x\nthis line holds hunter3-secret and no equals sign\n');
  const bad = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--test-env', env, '--', process.execPath, 'check.cjs']);
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(bad.stdout, /line\(s\) 2 /);
  assert.doesNotMatch(bad.stdout, /hunter3/);
  const missing = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--test-env', env + '.missing', '--', process.execPath, 'check.cjs']);
  assert.equal(missing.status, 2, missing.stdout);
  assert.match(missing.stdout, /cannot read --test-env/);
});

// The test machine reads the env file itself: only its path, and the time limit, cross over.
test('--show-remote: the env file (flag, or git config sanad.remoteTestEnv) and the time limit reach the test machine command', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  const config = (k, v) => execFileSync('git', ['config', k, v], { cwd: repo });
  config('sanad.remoteHost', 'pc-test'); config('sanad.remoteRepo', 'C:/r/repo'); config('sanad.remoteTestEnv', 'C:\\Users\\x\\eq.env');
  const command = ['--', 'dotnet', 'test', 'A.Tests/A.Tests.csproj', '--filter', 'FullyQualifiedName~Late'];
  const fromConfig = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--show-remote', ...command]);
  assert.equal(fromConfig.status, 0, fromConfig.stdout);
  assert.match(fromConfig.stdout, /--test-env C:\/Users\/x\/eq\.env /);
  assert.match(fromConfig.stdout, /--timeout-min 15 /);
  assert.match(fromConfig.stdout, / -- dotnet test A\.Tests\/A\.Tests\.csproj --filter FullyQualifiedName~Late$/m);
  const fromFlag = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--show-remote', '--test-env', 'D:/other.env', '--timeout-min', '5', ...command]);
  assert.match(fromFlag.stdout, /--test-env D:\/other\.env /);
  assert.match(fromFlag.stdout, /--timeout-min 5 /);
  assert.doesNotMatch(fromFlag.stdout, /eq\.env/);
  // 2026-11-09: the repository default is a database connection, so a frontend run does not get it.
  const vitest = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--show-remote', '--', 'node', 'node_modules/vitest/vitest.mjs', 'run', 'a.test.ts']);
  assert.equal(vitest.status, 0, vitest.stdout);
  assert.doesNotMatch(vitest.stdout, /--test-env/);
});

// 2026-11-09: nothing limited a run's time, so a hang was silent. Each run now has a limit (15 minutes
// unless --timeout-min says otherwise); a run past it is stopped with every process it started.
function hangFixture() {
  const { repo, breaks } = breakFixture();
  const pidFile = path.join(repo, '..', path.basename(repo) + '.pid');
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (!require("./rule.cjs").blocks || require("./app.cjs") === 3) {',
    '  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `  require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    '  setInterval(() => {}, 1000);',
    '} else if (require("./app.cjs") !== 2) { console.log([" FAIL  src/a.test.cjs > form > shows it once", "AssertionError: expected 2 to be 1"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  writeBreaks(breaks, ['saves nothing']);
  return { repo, breaks, pidFile };
}
function gone(pid) {
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
  }
  return false;
}

test('--timeout-min: a run past the limit is stopped with its whole process tree and named as TIMEOUT; files restored', () => {
  const { repo, breaks, pidFile } = hangFixture();
  const rule = fs.readFileSync(path.join(repo, 'rule.cjs'));
  const result = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--parallel', '3', '--timeout-min', '0.05', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 5, result.stdout + (result.error ? ' ' + result.error.message : ''));
  assert.match(result.stdout, /RED-PROOF: TIMEOUT ✗ — break the rule does not block ran past 0\.05 min/);
  assert.doesNotMatch(result.stdout, /TIMEOUT ✗ — (?:old code|green)/, 'only the run that hung');
  assert.match(result.stdout, /NOT PROVED ✗/);
  assert.ok(gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the process the run started is stopped too');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'rule.cjs')), rule);
});

test('--timeout-min with one --break: the file in the working folder comes back after the stop', () => {
  const { repo, pidFile } = hangFixture();
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const result = run(['--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', '--timeout-min', '0.05', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 5, result.stdout + (result.error ? ' ' + result.error.message : ''));
  assert.match(result.stdout, /TIMEOUT ✗ — break ran past 0\.05 min/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
  assert.ok(gone(Number(fs.readFileSync(pidFile, 'utf8'))));
});
