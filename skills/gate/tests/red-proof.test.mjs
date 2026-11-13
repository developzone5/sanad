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
  // 2026-11-12: the old code is red only by a named test that fails by an assertion, so the test says so.
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (require("./app.cjs") !== 2) { console.log(" FAIL  src/app.test.cjs > app > is fixed" + String.fromCharCode(10) + "AssertionError: expected 1 to be 2"); process.exit(1); }',
    'process.exit(0);', ''].join('\n'));
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
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'if (!require("node:fs").existsSync(__dirname + "/helper.cjs")) { console.log(" FAIL  src/helper.test.cjs > helper > exists\\nAssertionError: expected false to be true"); process.exit(1); }\n');
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

// 2026-11-13: a page proof stopped as SETUP because the old code did not render the notice the fix renders
// ("Unable to find an element with the text"). Green had passed with the same query, so the query works;
// on the old code the missing element is the product's own failure.
test('after a passing green run, an element the old code does not render is RED; without green it stays SETUP', () => {
  const { repo } = fixture();
  runnerOutput(repo, [' FAIL  src/a.test.tsx > notice > shows the saved notice', 'TestingLibraryElementError: Unable to find an element with the text: Saved. This could be because the text is broken up by multiple elements.']);
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const red = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(red.status, 0, red.stdout);
  assert.match(red.stdout, /\? missing\s+src\/a\.test\.tsx > notice > shows the saved notice — TestingLibraryElementError: Unable to find an element/);
  assert.match(red.stdout, /RED ✓ — the tests fail on HEAD for app\.cjs \(exit 1; 0 of 1 failing test\(s\) by an assertion, 1 by another error \(an element green found on the fixed tree is missing\): check above that it is the bug\)/);
  assert.match(red.stdout, /GREEN ✓/);
  assert.doesNotMatch(red.stdout, /SETUP ✗/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
  const setup = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(setup.status, 3, setup.stdout);
  assert.match(setup.stdout, /✗ setup\s+src\/a\.test\.tsx > notice > shows the saved notice/);
  assert.match(setup.stdout, /SETUP ✗ — 1 failed for a setup reason/);
});

test('after a passing green run: a missing role under one --break is RED too; any other setup reason still stops as SETUP', () => {
  const { repo } = fixture();
  runnerOutput(repo, [' FAIL  src/a.test.tsx > form > has the PDF button', 'TestingLibraryElementError: Unable to find role="button" and name "PDF"']);
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const broken = run(['--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(broken.status, 0, broken.stdout);
  assert.match(broken.stdout, /RED ✓ — the test fails with app\.cjs broken \(exit 1; 1 by another error \(an element green found on the fixed tree is missing\): check above that it is the bug\)/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
  const alone = run(['--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', '--', process.execPath, 'check.cjs']);
  assert.equal(alone.status, 3, 'without green the query is not proven: ' + alone.stdout);
  runnerOutput(repo, [' FAIL  src/a.test.tsx > notice > shows it', 'TestingLibraryElementError: Unable to find an element with the text: Saved', ' FAIL  src/a.test.tsx > notice > reads it', "TypeError: Cannot read properties of undefined (reading 'x')"]);
  const mixed = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--then-green', '--', process.execPath, 'check.cjs']);
  assert.equal(mixed.status, 3, mixed.stdout);
  assert.match(mixed.stdout, /✗ setup\s+src\/a\.test\.tsx > notice > reads it — TypeError/);
  assert.match(mixed.stdout, /SETUP ✗ — 1 failed for a setup reason/);
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
  // 2026-11-12 (S2): this pinned "RED ✓ — failure reasons not read" for any non-zero exit; a host crash
  // or a missing test then read as red. A run that names no failing test is NOT RED now.
  runnerOutput(repo, ['some runner we do not read']);
  const unread = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(unread.status, 1, unread.stdout);
  assert.match(unread.stdout, /NOT RED ✗ — the run fails on HEAD \(exit 1\), but no failing test was named \(failure reasons not read from this runner\)/);
  assert.doesNotMatch(unread.stdout, /RED ✓/);
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
  // The tests check.cjs stands for, by their own titles (2026-11-12: a mustFail part is matched to them).
  fs.writeFileSync(path.join(repo, 'src/a.test.cjs'), "describe('form', () => {\n  it('saves nothing', () => {});\n  it('shows it once', () => {});\n});\n");
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
  const { readRecord, provenTestFiles } = await import('../scripts/proof-record.mjs');
  const entries = Object.values(readRecord(repo).entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].breaks, 1);
  assert.deepEqual([...provenTestFiles(repo)], ['src/a.test.cjs'], 'the record covers the test file as it is now');
  fs.appendFileSync(path.join(repo, 'src/a.test.cjs'), '// edited after the proof\n');
  assert.deepEqual([...provenTestFiles(repo)], [], 'an edit after the proof voids it');
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

// 2026-11-11 (TUW-242): an older test still expected the old behavior; the proof said so only after its
// four red runs, 7 minutes in. Green now runs first and alone; the red runs start only when it passes.
test('--parallel: green runs first, then the red runs; a passing proof reads as before', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--parallel', '3', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  const ran = result.stdout.split(/\r?\n/).filter(l => /^ {2}ran /.test(l)).map(l => l.replace(/:.*/, '').trim());
  assert.deepEqual(ran.slice(0, 1), ['ran green'], 'green ran before the others: ' + ran.join(' | '));
  assert.equal(ran.length, 3);
  assert.match(result.stdout, /3 run\(s\), 3 at a time, each in its own copy; green first/);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓ — red on the old code, 1 break\(s\) caught, green on the fix/);
});

test('--then-green: when the fixed tree fails, the red runs are skipped and the proof ends at once', () => {
  for (const parallel of [[], ['--parallel', '3']]) {
    const { repo, breaks } = breakFixture();
    writeBreaks(breaks, ['saves nothing']);
    fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 3;\n');
    const rule = fs.readFileSync(path.join(repo, 'rule.cjs'));
    const result = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--breaks', breaks, '--then-green', ...parallel, '--', process.execPath, 'check.cjs']);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /GREEN ✗ the tests fail on the fixed tree/);
    assert.match(result.stdout, /✓ assert {2}src\/a\.test\.cjs > form > shows it once/, 'the failing test is named');
    assert.match(result.stdout, /RED-PROOF: NOT PROVED ✗ — the fixed tree fails its own tests, so the red runs were skipped/);
    assert.doesNotMatch(result.stdout, /ran (?:old code|break)|RED ✓|BREAK [✓✗]/, 'no red run started: ' + parallel.join(' '));
    assert.deepEqual(fs.readFileSync(path.join(repo, 'rule.cjs')), rule);
  }
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
    const { writeEntry, readRecord } = await import('../scripts/proof-record.mjs');
    writeEntry(alias, 'k', { ok: true, breaks: 1, files: { 'src/a.test.cjs': 'x' }, targets: {} });
    assert.equal(readRecord(repo)?.entries?.k?.breaks, 1, 'written through the link, read through the real path');
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

// 2026-11-13: on the test machine every copy built the whole .NET solution at every proof, about 5 minutes
// each. Two causes, both checked on a real two-project build: each sync is a new commit, and the SDK writes
// the commit id into every assembly (InformationalVersion), so a new commit alone recompiles every project;
// and a copy that never built pays a whole build, while build output copied in from another folder
// recompiles everything too. A fake `dotnet` (Node under that name, this script preloaded) builds like
// MSBuild by file times: it recompiles when a source is newer than its output, and its tests load the
// built output, never the sources, so a break that was not compiled is not seen.
const fakeDotnet = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-dotnet-'));
  const exe = path.join(dir, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  const preload = path.join(dir, 'fake-dotnet.cjs');
  fs.writeFileSync(preload, [
    'const fs = require("node:fs"), path = require("node:path");',
    'if (/^dotnet(?:\\.exe)?$/i.test(path.basename(process.execPath))) {',
    '  const args = process.argv.slice(2), sources = ["app.cjs", "rule.cjs"], out = path.join("obj", "build.json");',
    '  let outTime = -1;',
    '  try { outTime = fs.statSync(out).mtimeMs; } catch { /* never built here */ }',
    '  const newer = sources.filter(f => fs.statSync(f).mtimeMs > outTime);',
    '  const state = outTime < 0 ? "cold" : newer.length ? "incremental" : "up to date";',
    '  if (state !== "up to date") { fs.mkdirSync("obj", { recursive: true }); fs.writeFileSync(out, JSON.stringify(Object.fromEntries(sources.map(f => [f, fs.readFileSync(f, "utf8")])))); }',
    '  fs.appendFileSync(process.env.FAKE_DOTNET_LOG, JSON.stringify({ cwd: process.cwd(), state, newer, list: args.includes("--list-tests"), srcRev: process.env.IncludeSourceRevisionInInformationalVersion ?? null }) + "\\n");',
    '  if (args.includes("--list-tests")) { fs.writeSync(1, "The following Tests are available:\\n"); process.exit(0); }',
    '  const built = JSON.parse(fs.readFileSync(out, "utf8"));',
    '  const load = (text) => { const m = { exports: {} }; new Function("module", "exports", text)(m, m.exports); return m.exports; };',
    '  const fails = [];',
    '  if (!load(built["rule.cjs"]).blocks) fails.push(" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0");',
    '  if (load(built["app.cjs"]) !== 2) fails.push(" FAIL  src/a.test.cjs > form > shows it once", "AssertionError: expected 2 to be 1");',
    '  if (fails.length) { fs.writeSync(1, fails.join("\\n") + "\\n"); process.exit(1); }',
    '  process.exit(0);',
    '}', ''].join('\n'));
  return { exe, nodeOptions: `--require "${preload.replace(/\\/g, '/')}"` };
})();
const dotnetRun = (repo, args, log) => run(['--repo', repo, ...args, '--', fakeDotnet.exe, 'test', 'Fixture.csproj'], { NODE_OPTIONS: fakeDotnet.nodeOptions, FAKE_DOTNET_LOG: log });
const builds = (log) => { try { return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function builtFixture() {
  const { repo, breaks } = breakFixture();
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'obj/\n');
  git('add', '.gitignore'); git('commit', '-qm', 'ignore build output');
  writeBreaks(breaks, ['saves nothing']);
  const log = path.join(repo, '..', path.basename(repo) + '-dotnet.jsonl');
  return { repo, breaks, git, log };
}

test('a dotnet proof builds once: every run shares the copy the compile check built, and builds only what its change touched', () => {
  const { repo, breaks, log } = builtFixture();
  const result = dotnetRun(repo, ['--base', 'HEAD', '--old', 'HEAD', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--parallel', '3'], log);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓ — red on the old code, 1 break\(s\) caught, green on the fix/);
  const seen = builds(log);
  assert.deepEqual(seen.map(b => [b.list ? 'compile check' : 'run', b.state]),
    [['compile check', 'cold'], ['run', 'up to date'], ['run', 'incremental'], ['run', 'incremental']], 'one whole build, then green and the red runs: ' + JSON.stringify(seen));
  assert.equal(new Set(seen.map(b => b.cwd)).size, 1, 'every run in the copy that built: ' + seen.map(b => b.cwd).join(' | '));
  assert.ok(seen[2].newer.includes('app.cjs'), 'the old code was compiled into the run that tested it');
  assert.ok(seen[3].newer.includes('rule.cjs'), 'the break was newer than the output, so it was compiled into its run');
  assert.ok(seen.every(b => b.srcRev === 'false'), 'a copy builds without the commit id, so a new commit recompiles nothing');
  assert.match(result.stdout, /2 copies never built here sit out/);
});

test('--warm builds each copy once; a later proof runs in all of them at once; a frontend command leaves them alone', () => {
  const { repo, breaks, log } = builtFixture();
  const warm = dotnetRun(repo, ['--warm', '--parallel', '3'], log);
  assert.equal(warm.status, 0, warm.stdout);
  const warmed = builds(log);
  assert.equal(warmed.filter(b => b.state === 'cold').length, 3, JSON.stringify(warmed));
  fs.rmSync(log);
  const proof = dotnetRun(repo, ['--base', 'HEAD', '--old', 'HEAD', '--files', 'app.cjs', '--breaks', breaks, '--then-green', '--parallel', '3'], log);
  assert.equal(proof.status, 0, proof.stdout);
  assert.match(proof.stdout, /3 run\(s\), 3 at a time, each in its own copy; green first/);
  assert.doesNotMatch(proof.stdout, /sit out/);
  const seen = builds(log);
  assert.deepEqual(seen.filter(b => b.state === 'cold'), [], 'no whole build during the proof: ' + JSON.stringify(seen));
  assert.deepEqual([...new Set(seen.map(b => b.cwd))].sort(), [...new Set(warmed.map(b => b.cwd))].sort(), 'the runs used the warmed copies');
  // A frontend proof at the same time must not hold the built copies, and gets no build setting.
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'console.log("CWD=" + process.cwd() + " SRCREV=" + process.env.IncludeSourceRevisionInInformationalVersion);',
    'if (!require("./rule.cjs").blocks) { console.log([" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  const pageLog = path.join(repo, '..', path.basename(repo) + '-page.log');
  const page = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '2', '--log', pageLog, '--', process.execPath, 'check.cjs']);
  assert.equal(page.status, 0, page.stdout);
  assert.match(page.stdout, /2 run\(s\), 2 at a time, each in its own copy/);
  const used = [...fs.readFileSync(pageLog, 'utf8').matchAll(/CWD=(\S+) SRCREV=(\S+)/g)];
  assert.equal(used.length, 2, fs.readFileSync(pageLog, 'utf8'));
  const warmedDirs = new Set(warmed.map(b => path.resolve(b.cwd).toLowerCase()));
  for (const [, cwd, srcRev] of used) {
    assert.ok(!warmedDirs.has(path.resolve(cwd).toLowerCase()), 'the frontend run took a built copy: ' + cwd);
    assert.equal(srcRev, 'undefined');
  }
});

test('a dotnet run in a kept copy builds without the commit id, unless the environment sets it', async () => {
  const { copyRunEnv } = await import('../scripts/red-proof.mjs');
  assert.deepEqual(copyRunEnv(['dotnet', 'test', 'A.csproj'], { A: '1' }), { A: '1', IncludeSourceRevisionInInformationalVersion: 'false' });
  assert.deepEqual(copyRunEnv(['C:/Program Files/dotnet/dotnet.exe', 'test'], {}), { IncludeSourceRevisionInInformationalVersion: 'false' });
  const own = { includesourcerevisionininformationalversion: 'true' };
  assert.equal(copyRunEnv(['dotnet', 'test'], own, 'win32'), own, 'the env file or the machine already decides it');
  const env = { A: '1' };
  assert.equal(copyRunEnv([process.execPath, 'node_modules/vitest/vitest.mjs', 'run'], env), env, 'other runners are left alone');
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

// 2026-11-10: xUnit printed each failing test by its DisplayName; mustFail named the methods, and four
// breaks read "not seen failing" although their tests had failed.
test('a mustFail part matches a test by its method or by its xUnit DisplayName, either way round', async () => {
  const { survivors, displayNames } = await import('../scripts/red-proof.mjs');
  const pairs = displayNames([
    'public class FloorTests {',
    '  [Fact(DisplayName = "[C1] lowering below used refuses")]',
    '  public async Task AttemptsFloor_C1() { }',
    '  [Fact]',
    '  public void NoDisplayName() { }',
    '  [Theory(DisplayName = "[C2] a \\"quoted\\" case")]',
    '  [InlineData(1)]',
    '  public void AttemptsFloor_C2(int n) { }',
    '}'].join('\n'));
  assert.deepEqual(pairs, [
    { display: '[C1] lowering below used refuses', method: 'AttemptsFloor_C1' },
    { display: '[C2] a "quoted" case', method: 'AttemptsFloor_C2' }]);
  const byDisplay = [{ name: '[C1] lowering below used refuses', kind: 'assert' }, { name: '[C2] a "quoted" case(n: 1)', kind: 'assert' }];
  assert.deepEqual(survivors(['AttemptsFloor_C1', 'AttemptsFloor_C2'], byDisplay, pairs), []);
  assert.deepEqual(survivors(['AttemptsFloor_C1'], byDisplay), ['AttemptsFloor_C1'], 'without the pairs the method is not seen');
  const byMethod = [{ name: 'Api.Tests.FloorTests.AttemptsFloor_C1', kind: 'assert' }];
  assert.deepEqual(survivors(['[C1] lowering below'], byMethod, pairs), []);
  assert.deepEqual(survivors(['AttemptsFloor_C2'], byMethod, pairs), ['AttemptsFloor_C2'], 'another test failing is not this one');
});

test('--breaks: a mustFail method name catches a test that dotnet printed by its DisplayName', () => {
  const { repo, breaks } = breakFixture();
  fs.mkdirSync(path.join(repo, 'Tests'));
  fs.writeFileSync(path.join(repo, 'Tests', 'RuleTests.cs'), '[Fact(DisplayName = "[C1] the rule blocks the save")]\npublic void Rule_Blocks() { }\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (!require("./rule.cjs").blocks) { console.log("  Failed [C1] the rule blocks the save [12 ms]\\n  Error Message:\\n   Assert.True() Failure"); process.exit(1); }',
    'process.exit(0);', ''].join('\n'));
  writeBreaks(breaks, ['Rule_Blocks']);
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /BREAK ✓ the rule does not block: all 1 named test\(s\) fail/);
});

// 2026-11-10: a fix file that only added the new error message went back to the old code too; the old
// code could not compile against the new tests (SETUP), and the whole proof ran again.
test('a fix file that only adds names the tests use stays at the fix for the old-code run', async () => {
  const { addedNames } = await import('../scripts/red-proof.mjs');
  const decl = '+    public static readonly ApiMessage ExamAttemptsBelowUsed = new("EXAM_ATTEMPTS_BELOW_USED", "…");';
  const tests = 'Assert.Equal(AttemptMessages.ExamAttemptsBelowUsed.Code, result.Code);';
  assert.deepEqual(addedNames(['@@ -10,0 +11 @@', decl].join('\n'), 'class AttemptMessages { }', tests, 'AttemptMessages.cs'), ['ExamAttemptsBelowUsed']);
  assert.deepEqual(addedNames(['@@ -10 +10 @@', '-    old line', decl].join('\n'), '', tests, 'AttemptMessages.cs'), [], 'a file that also changes a line may hold the fix');
  assert.deepEqual(addedNames(['@@ -3,0 +4 @@', '+  if (code == AttemptMessages.ExamAttemptsBelowUsed.Code) return 409;'].join('\n'), '', tests, 'Controller.cs'), [], 'a use is not a declaration');
  assert.deepEqual(addedNames(['@@ -10,0 +11 @@', decl].join('\n'), 'ExamAttemptsBelowUsed', tests, 'AttemptMessages.cs'), [], 'a name the old file had is not new');

  const { repo, git } = fixture();
  fs.writeFileSync(path.join(repo, 'names.cjs'), 'module.exports = {\n  OLD_NAME: 1,\n};\n');
  git('add', 'names.cjs'); git('commit', '-qm', 'names');
  fs.writeFileSync(path.join(repo, 'names.cjs'), 'module.exports = {\n  OLD_NAME: 1,\n  NEW_NAME: 2,\n};\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.test.cjs'), '// expects NEW_NAME\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (require("./names.cjs").NEW_NAME === undefined) { console.log("Build FAILED.\\nA.cs(3,1): error CS0117: \'Names\' does not contain a definition for \'NEW_NAME\'"); process.exit(1); }',
    'if (require("./app.cjs") !== 2) { console.log(" FAIL  src/a.test.cjs > fix > is applied\\nAssertionError: expected 1 to be 2"); process.exit(1); }',
    'process.exit(0);', ''].join('\n'));
  const before = fs.readFileSync(path.join(repo, 'names.cjs'));
  // HEAD has the bug in app.cjs and names.cjs without NEW_NAME.
  const kept = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD', '--files', 'app.cjs,names.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(kept.status, 0, kept.stdout);
  assert.match(kept.stdout, /names\.cjs stays at the fix for the old-code run: it only adds lines, and the tests use its new names \(NEW_NAME\)/);
  assert.match(kept.stdout, /RED ✓ — the tests fail on HEAD for app\.cjs \(/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'names.cjs')), before);

  // The same name declared in a file that also changes a line: no keep, and the SETUP names what is missing.
  fs.writeFileSync(path.join(repo, 'names.cjs'), 'module.exports = {\n  OLD_NAME: 3,\n  NEW_NAME: 2,\n};\n');
  const setup = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD', '--files', 'app.cjs,names.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(setup.status, 3, setup.stdout);
  assert.doesNotMatch(setup.stdout, /stays at the fix/);
  assert.match(setup.stdout, /the old code lacks names the tests use: NEW_NAME\./);

  // On the test machine (a plan), a NOT RED still names the file that stayed at the fix.
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'process.exit(0);\n');
  const planFile = path.join(repo, '..', path.basename(repo) + '-plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ oldLabel: 'HEAD', kept: ['names.cjs'], breaks: [], old: [{ file: 'app.cjs', content64: Buffer.from('module.exports = 1;\n').toString('base64') }] }));
  const remote = run(['--repo', repo, '--local', '--plan', planFile, '--', process.execPath, 'check.cjs']);
  assert.equal(remote.status, 1, remote.stdout);
  assert.match(remote.stdout, /NOT RED ✗/);
  assert.match(remote.stdout, /names\.cjs stayed at the fix \(see above\)/);
});

// 2026-11-10: the first proof of a task found its copies cold; each run built the whole solution.
test('--warm: the kept copies are prepared once before the proof; with a proof it is refused', () => {
  const { repo } = fixture();
  const result = run(['--repo', repo, '--warm', '--parallel', '2', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /warming 2 kept copies/);
  assert.match(result.stdout, /copy 0: ready/);
  assert.match(result.stdout, /WARM ✓ — 2 copies ready/);
  const proof = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--parallel', '2', '--', process.execPath, 'check.cjs']);
  assert.equal(proof.status, 0, proof.stdout);
  assert.match(proof.stdout, /RED ✓/);
  const refused = run(['--repo', repo, '--warm', '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stdout, /--warm only prepares the kept copies/);
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

// ---- 2026-11-12 audit fixes ----

// S2: a stopped database or a crashed test host failed every red run, and the proof read PROVED ✓.
const ENVIRONMENT_LINE = /RED-PROOF: ENVIRONMENT ✗ — the test machine failed \(database or host\), not the tests; fix it and run the same proof again\./;
test('a database or host failure is ENVIRONMENT (exit 6) on the old code, never RED', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  runnerOutput(repo, ['  Failed Api.Tests.HomeworkTests.LateAtTheMinute [1 s]', '  Error Message:', '   MySqlConnector.MySqlException : Unable to connect to any of the specified MySQL hosts.']);
  const db = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(db.status, 6, db.stdout);
  assert.match(db.stdout, ENVIRONMENT_LINE);
  assert.match(db.stdout, /✗ env\s+Api\.Tests\.HomeworkTests\.LateAtTheMinute — .*Unable to connect/);
  assert.doesNotMatch(db.stdout, /RED ✓/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
  runnerOutput(repo, ['Starting test execution, please wait...', 'The active test run was aborted. Reason: Test host process crashed : Fatal error.']);
  const host = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(host.status, 6, host.stdout);
  assert.match(host.stdout, ENVIRONMENT_LINE);
});

test('a break run that fails on the database is ENVIRONMENT, not a caught break', () => {
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (!require("./rule.cjs").blocks) { console.log([" FAIL  src/a.test.cjs > form > saves nothing", "Error: connect ECONNREFUSED 127.0.0.1:3307"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  writeBreaks(breaks, ['saves nothing']);
  for (const parallel of [['--parallel', '1'], ['--parallel', '2']]) {
    const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', ...parallel, '--', process.execPath, 'check.cjs']);
    assert.equal(result.status, 6, result.stdout);
    assert.match(result.stdout, ENVIRONMENT_LINE);
    assert.doesNotMatch(result.stdout, /BREAK ✓|PROVED ✓/);
  }
});

test('the old code is red by a named failing test: an unread runner or no test run is NOT RED; a product error counts and is named', () => {
  const { repo } = fixture();
  // A named test that fails by an error the old code throws is the bug too (not an assertion, so the line says it).
  runnerOutput(repo, [' FAIL  src/a.test.tsx > list > shows it', 'Error: boom']);
  const other = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(other.status, 0, other.stdout);
  assert.match(other.stdout, /RED ✓ — the tests fail on HEAD for app\.cjs \(exit 1; 0 of 1 failing test\(s\) by an assertion, 1 by another error: check above that it is the bug\)/);
  runnerOutput(repo, ['', ' RUN  v3.2.4', 'No test files found, exiting with code 1']);
  const none = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(none.status, 1, none.stdout);
  assert.match(none.stdout, /NOT RED ✗ — no test ran on HEAD/);
});

test('jest-dom and Moq failures read as assertions; a connection failure reads as the environment', async () => {
  const { failureReasons } = await import('../scripts/red-proof.mjs');
  const kinds = failureReasons([' FAIL  src/a.test.tsx > form > shows the hint', 'Error: expect(element).toBeInTheDocument()',
    '  Failed Api.Tests.T.Saves [1 ms]', '  Error Message:', '   Moq.MockException : Expected invocation on the mock once, but was 0 times: x => x.Save()',
    '  Failed Api.Tests.T.Loads [1 ms]', '  Error Message:', '   MySqlConnector.MySqlException : Connect Timeout expired.'].join('\n')).map(w => w.kind);
  assert.deepEqual(kinds, ['assert', 'assert', 'env']);
  // A screen text or an asserted value that names a connection error is the test's own failure, not the machine's.
  const own = failureReasons([' FAIL  src/a.test.tsx > banner > shows the offline text', 'TestingLibraryElementError: Unable to find an element with the text: Unable to connect to the server',
    ' FAIL  src/a.test.tsx > retry > keeps the code', "AssertionError: expected 'ETIMEDOUT' to be 'ECONNREFUSED'"].join('\n')).map(w => w.kind);
  assert.deepEqual(own, ['setup', 'assert']);
});

// S6: a break whose text crashed everything failed every named test and read as caught.
test('--breaks: a break that does not compile or run is BREAK INVALID, never caught', () => {
  const { repo, breaks } = breakFixture();
  writeBreaks(breaks, ['saves nothing']);
  for (const crash of [[' FAIL  src/a.test.cjs > form > saves nothing', 'ReferenceError: blokcs is not defined'], ['Build FAILED.', 'Rule.cs(3,1): error CS0103: The name \'blokcs\' does not exist in the current context']]) {
    fs.writeFileSync(path.join(repo, 'check.cjs'), `if (!require("./rule.cjs").blocks) { console.log(${JSON.stringify(crash.join('\n'))}); process.exit(1); }\n`);
    const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', process.execPath, 'check.cjs']);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /BREAK INVALID ✗ the rule does not block: the break does not compile\/run; write a break that changes one rule/);
    assert.match(result.stdout, /RED-PROOF: NOT PROVED ✗/);
    assert.doesNotMatch(result.stdout, /BREAK ✓/);
  }
});

test('--break: a break that makes a ReferenceError is BREAK INVALID, not RED; the file comes back', () => {
  const { repo } = fixture();
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'if (require("./app.cjs") !== 2) { console.log(" FAIL  src/app.test.cjs > app > is fixed\\nReferenceError: exprts is not defined"); process.exit(1); }\n');
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  const result = run(breakArgs(repo, 'exports = 2', 'exports = 3'));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /BREAK INVALID ✗ break: the break does not compile\/run/);
  assert.match(result.stdout, /RED-PROOF: NOT RED ✗/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before);
});

test('a break whose --put is its --find changes nothing: BREAK INVALID, and nothing runs', () => {
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'same text', file: 'rule.cjs', find: 'blocks: true', put: 'blocks: true', mustFail: ['saves nothing'] }]));
  const many = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', process.execPath, 'check.cjs']);
  assert.equal(many.status, 1, many.stdout);
  assert.match(many.stdout, /BREAK INVALID ✗ same text: the break changes nothing/);
  assert.doesNotMatch(many.stdout, /ran |BREAK ✓|BREAK ✗ same/);
  const one = run(breakArgs(repo, 'exports = 2', 'exports = 2'));
  assert.equal(one.status, 1, one.stdout);
  assert.match(one.stdout, /BREAK INVALID ✗ break: the break changes nothing/);
});

test('a break text matched with other line endings: applied in either, and a no-op is found', async () => {
  const { applyBreak } = await import('../scripts/red-proof.mjs');
  assert.equal(applyBreak('a\r\nb\r\nc', 'a\nb', 'a\nX'), 'a\r\nX\r\nc', 'an LF break in a CRLF file');
  assert.equal(applyBreak('a\nb\nc', 'a\r\nb', 'a\r\nX'), 'a\nX\nc', 'a CRLF break in an LF file');
  assert.equal(applyBreak('a\nb', 'zzz', 'y'), null, 'not found: nothing would change');
  assert.equal(applyBreak('a\nb', 'a', 'a'), null, 'the same text: nothing would change');
  assert.equal(applyBreak('a a', 'a', 'b'), null, 'twice: not one rule');
});

test('--parallel: a break written with LF lines still breaks a copy that checked the file out with CRLF', () => {
  const { repo, breaks } = breakFixture();
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'rule.cjs text eol=crlf\n');
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = {\n  blocks: true,\n};\n');
  git('add', '.gitattributes', 'rule.cjs'); git('commit', '-qm', 'crlf rule');
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = {\n  blocks: true,\n};\n'); // LF here, CRLF in each copy
  assert.equal(git('status', '--porcelain', '--', 'rule.cjs').trim(), '', 'the folder copy counts as unchanged');
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'the rule does not block', file: 'rule.cjs', find: '{\n  blocks: true', put: '{\n  blocks: false', mustFail: ['saves nothing'] }]));
  const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--parallel', '2', '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /BREAK ✓ the rule does not block/);
});

// S7: --files was never checked.
test('--files: a test file is refused; product files the old-code run keeps at the fix are named', () => {
  const { repo } = fixture();
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/app.test.cjs'), "it('is fixed', () => {});\n");
  const refused = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs,src/app.test.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stdout, /--files names test file\(s\): src\/app\.test\.cjs/);
  assert.doesNotMatch(refused.stdout, /RED ✓|ran /);
  fs.writeFileSync(path.join(repo, 'other.cjs'), 'module.exports = "also changed";\n');
  const warned = run(['--repo', repo, '--old', 'HEAD', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(warned.status, 0, warned.stdout);
  assert.match(warned.stdout, /RED-PROOF: WARNING — product file\(s\) differ from HEAD but are not in --files.*other\.cjs/);
  assert.doesNotMatch(warned.stdout, /WARNING.*app\.test\.cjs/, 'test files are not product files');
});

// S5: an early exit left the previous proof.log (with its PROVED) in place.
test('--log is emptied at the start and written on every exit; its first line names the tree under test', () => {
  const { repo, git } = fixture();
  const log = path.join(repo, '..', path.basename(repo) + '-early.log');
  fs.writeFileSync(log, 'RED-PROOF: PROVED ✓ — a proof of another tree\n');
  const early = run(['--repo', repo, '--break', 'app.cjs', '--find', 'not there', '--put', 'x', '--log', log, '--', process.execPath, 'check.cjs']);
  assert.equal(early.status, 2, early.stdout);
  let text = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(text, /PROVED/);
  assert.match(text, /matches 0 time\(s\)/, 'the early exit line is in the log');
  const dirtyTree = /^RED-PROOF-LOG: tree ([0-9a-f]{40})\b/.exec(text.split(/\r?\n/)[0]);
  assert.ok(dirtyTree, 'first line: ' + text.split(/\r?\n/)[0]);
  assert.notEqual(dirtyTree[1], git('rev-parse', 'HEAD^{tree}'), 'uncommitted work is part of the tree');
  git('add', '-A'); git('commit', '-qm', 'all');
  const clean = run(['--repo', repo, '--old', 'HEAD~1', '--files', 'app.cjs', '--log', log, '--', process.execPath, 'check.cjs']);
  assert.equal(clean.status, 0, clean.stdout);
  text = fs.readFileSync(log, 'utf8');
  assert.equal(/^RED-PROOF-LOG: tree ([0-9a-f]{40})\b/.exec(text)?.[1], git('rev-parse', 'HEAD^{tree}'));
  assert.equal(dirtyTree[1], git('rev-parse', 'HEAD^{tree}'), 'the same files committed give the same tree');
  assert.match(text, /RED-PROOF: RED ✓/);
});

// S4 / C5 / S12 / S8: one record per repository, one entry per proof.
test('the proof record: an entry per command and folder, merged; an old-code-only run and a single --break leave it; only files with a caught test count', async () => {
  const { readRecord, provenTestFiles } = await import('../scripts/proof-record.mjs');
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(path.join(repo, 'src/other.test.cjs'), "it('unrelated', () => {});\n");
  writeBreaks(breaks, ['saves nothing']);
  const proof = (...extra) => run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--then-green', '--', process.execPath, 'check.cjs', ...extra]);
  assert.equal(proof().status, 0);
  let entries = Object.values(readRecord(repo).entries);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0].files), ['src/a.test.cjs'], 'only the file that holds a caught test');
  assert.deepEqual(Object.keys(entries[0].targets), ['rule.cjs']);
  const old = run(['--repo', repo, '--base', 'HEAD', '--old', 'HEAD~1', '--files', 'app.cjs', '--', process.execPath, 'check.cjs']);
  assert.equal(old.status, 0, old.stdout);
  const single = run(['--repo', repo, '--base', 'HEAD', '--break', 'rule.cjs', '--find', 'blocks: true', '--put', 'blocks: false', '--', process.execPath, 'check.cjs']);
  assert.equal(single.status, 0, single.stdout);
  assert.deepEqual(Object.values(readRecord(repo).entries), entries, 'neither run touched the record');
  assert.equal(proof('--second').status, 0);
  entries = Object.values(readRecord(repo).entries);
  assert.equal(entries.length, 2, 'another command adds its own entry');
  assert.deepEqual([...provenTestFiles(repo)], ['src/a.test.cjs']);
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = { blocks: true }; // changed after the proof\n');
  assert.deepEqual([...provenTestFiles(repo)], [], 'a changed break target voids the entries that broke it');
});

// S13: Ctrl-C (or a stop) during a single --break left the product file broken in the working folder.
test('--break: SIGINT, SIGTERM and SIGBREAK stop the run, put the file back and end the run', () => {
  const { repo, pidFile } = hangFixture();
  const before = fs.readFileSync(path.join(repo, 'app.cjs'));
  // Windows has no way to send a signal to another process, so the run's own process raises it.
  const wrapper = path.join(repo, '..', path.basename(repo) + '-signal.mjs');
  fs.writeFileSync(wrapper, [
    "import fs from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    'const [script, pidFile, signal, ...args] = process.argv.slice(2);',
    'process.argv = [process.argv[0], script, ...args];',
    'const timer = setInterval(() => { if (fs.existsSync(pidFile)) { clearInterval(timer); process.emit(signal, signal); } }, 50);',
    'await import(pathToFileURL(script).href);', ''].join('\n'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    fs.rmSync(pidFile, { force: true });
    const result = spawnSync(process.execPath, [wrapper, script, pidFile, signal, '--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', '--timeout-min', '1', '--', process.execPath, 'check.cjs'],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 2, signal + ': ' + result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`RED-PROOF: NOT PROVED ✗ — stopped by ${signal}; files restored`));
    assert.deepEqual(fs.readFileSync(path.join(repo, 'app.cjs')), before, signal);
    assert.ok(gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the run it started is stopped too: ' + signal);
  }
});

// S22: a mustFail part matched the full name (file > describe > test), so a tag on a describe or a shared
// tag let one failing test stand for all.
test('a mustFail part matches a test\'s own title, and every test with that part must fail', async () => {
  const { survivors, failureReasons } = await import('../scripts/red-proof.mjs');
  const declared = [{ titles: ['saves nothing'] }, { titles: ['shows it once'] }, { titles: ['[C2] blocks a'] }, { titles: ['[C2] blocks b'] }];
  const failed = failureReasons([' FAIL  src/a.test.cjs > [C1] form > saves nothing', 'AssertionError: expected 1 to be 0', ' FAIL  src/a.test.cjs > [C2] blocks a', 'AssertionError: expected 1 to be 0'].join('\n'));
  assert.deepEqual(survivors(['[C1]'], failed, [], declared), ['[C1]'], 'a tag on the describe names no test');
  assert.deepEqual(survivors(['a.test.cjs'], failed, [], declared), ['a.test.cjs'], 'nor does the file name');
  assert.deepEqual(survivors(['saves nothing'], failed, [], declared), []);
  assert.deepEqual(survivors(['[C2]'], failed, [], declared).map(s => s.replace(/ \(.*$/, '')), ['[C2]'], 'blocks b did not fail');
  assert.match(survivors(['[C2]'], failed, [], declared)[0], /blocks b/);
  assert.deepEqual(survivors(['[C2] blocks a'], failed, [], declared), []);
});

test('--breaks: a tag on a describe, or one failing test of two that share a tag, does not catch the break', () => {
  const { repo, breaks } = breakFixture();
  fs.writeFileSync(path.join(repo, 'src/a.test.cjs'), "describe('[C1] form', () => {\n  it('saves nothing', () => {});\n});\nit('[C2] blocks a', () => {});\nit('[C2] blocks b', () => {});\n");
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (!require("./rule.cjs").blocks) { console.log([" FAIL  src/a.test.cjs > [C1] form > saves nothing", "AssertionError: expected 1 to be 0", " FAIL  src/a.test.cjs > [C2] blocks a", "AssertionError: expected 1 to be 0"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  for (const [mustFail, ok] of [[['[C1]'], false], [['[C2]'], false], [['saves nothing', '[C2] blocks a'], true]]) {
    writeBreaks(breaks, mustFail);
    const result = run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, '--', process.execPath, 'check.cjs']);
    assert.equal(result.status, ok ? 0 : 1, mustFail.join(',') + ': ' + result.stdout);
    assert.match(result.stdout, ok ? /BREAK ✓/ : /BREAK ✗ the rule does not block: still pass \(or not seen failing\)/);
  }
});

// S3: on the test machine, the proof read HEAD again after its sync; a second sync in between moved it.
test('--plan with a commit: the copies are that commit, not the HEAD the folder has now', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-tests-'));
  fixtures.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = { blocks: true };\n');
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'synced\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'console.log("MARKER=" + require("node:fs").readFileSync("marker.txt", "utf8").trim());',
    'if (!require("./rule.cjs").blocks) { console.log([" FAIL  src/a.test.cjs > form > saves nothing", "AssertionError: expected 1 to be 0"].join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n'));
  git('add', '-A'); git('commit', '-qm', 'synced');
  const synced = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'moved\n'); git('commit', '-qam', 'another sync');
  const planFile = path.join(repo, '..', path.basename(repo) + '-plan.json');
  const log = path.join(repo, '..', path.basename(repo) + '-plan.log');
  const plan = (commit) => fs.writeFileSync(planFile, JSON.stringify({ commit, green: true, breaks: [{ name: 'the rule does not block', file: 'rule.cjs', find: 'blocks: true', put: 'blocks: false', mustFail: ['saves nothing'] }] }));
  plan(synced);
  const result = run(['--repo', repo, '--local', '--plan', planFile, '--parallel', '2', '--log', log, '--', process.execPath, 'check.cjs']);
  assert.equal(result.status, 0, result.stdout);
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /MARKER=synced/);
  assert.doesNotMatch(text, /MARKER=moved/);
  assert.equal(/^RED-PROOF-LOG: tree ([0-9a-f]{40})/.exec(text)?.[1], git('rev-parse', synced + '^{tree}'), 'the log names the synced tree');
  plan('0123456789abcdef0123456789abcdef01234567');
  const missing = run(['--repo', repo, '--local', '--plan', planFile, '--parallel', '2', '--', process.execPath, 'check.cjs']);
  assert.equal(missing.status, 2, missing.stdout);
  assert.match(missing.stdout, /the synced commit 0123456789ab is not on this machine/);
});
