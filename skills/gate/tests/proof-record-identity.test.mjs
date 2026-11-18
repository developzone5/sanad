// 2026-11-17, from an independent audit of the proof record (its findings 1 and 2):
// 1. "One caught test certifies another rule's vacuous negative check": the record held whole test FILES, so a
//    caught test proved every "nothing happens" check of its file. One file held `[C1] returns the correct value`
//    (a break made it fail) and `[C2] refuses unauthorized writes`, which builds an empty list and checks its
//    length without calling the product. The proof read PROVED and the test check read "1 "nothing happens"
//    check(s) proven by a break run", while the product wrote the unauthorized row. The record now names the tests
//    each break made fail, and a check counts only when the test that holds its line is one of them.
// 2. "Stale mutation proof survives dependency edits and even a failed re-proof": the record counted while the
//    break targets and the test files were unchanged. An edit to a dependency (`items => items` to `items => []`)
//    left the test green and the old proof valid, though the same break no longer failed the test; and the fresh
//    proof that said NOT PROVED did not take the old success back. The record now holds one id of all the code
//    under test, and a proof that starts and does not end PROVED leaves its entry not ok.
// Real proofs (red-proof.mjs) and the real test check (check-test-asserts.mjs) in child processes; a small
// harness stands in for the test runner: it runs real assertions and prints its failures the way vitest does.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRecord, writeEntry, testFileHashes } from '../scripts/proof-record.mjs';
import { gitBash } from '../scripts/git-bash.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const redProof = path.join(scripts, 'red-proof.mjs'), testCheck = path.join(scripts, 'check-test-asserts.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-identity-'));
// The fixtures must not see this machine's git settings (a test machine there sends runs away).
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = path.join(root, 'state');
process.env.SANAD_STATE_DIR = state; // readRecord and writeEntry here use the folder the runs use
const env = (extra = {}) => ({ ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state, ...extra });
const node = (file, args, extra = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: env(extra) });
const repos = [];
after(() => {
  for (const repo of repos) node(redProof, ['--repo', repo, '--drop-copies']);
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
// A repository on branch `task`, cut from `main`: main holds `base`, the working tree then holds `work` too.
function repoWith(base, work = {}) {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  repos.push(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: env() }).trim();
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  write(base); git('add', '--all'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'task');
  write(work);
  const marker = path.join(root, `ran${n}.txt`), breaks = path.join(root, `breaks${n}.json`);
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
  // A proof of this repository (its breaks in a file outside it), and the test check pre-review runs after it.
  const proof = (list, args = [], extra = {}, command = [process.execPath, 'check.cjs']) => {
    fs.writeFileSync(breaks, JSON.stringify(list));
    return node(redProof, ['--repo', repo, '--breaks', breaks, ...args, '--', ...command], { RAN_MARKER: marker, ...extra });
  };
  const check = (base = 'main') => node(testCheck, ['--repo', repo, '--base', base]);
  const entries = () => Object.values(readRecord(repo)?.entries || {});
  return { repo, git, write, ran, proof, check, entries };
}
const lines = (...l) => l.join('\n') + '\n';

// ---- Finding 1: the audit's fixture. The product writes an unauthorized row whatever it is asked. ----
const CALC = lines('module.exports = {', '  value: () => 2,', "  write: (rows) => { rows.push('unauthorized write'); },", '};');
// The harness: [C1] really checks the value; [C2] checks an empty list it made itself and never calls the product.
const CHECK_RULES = lines(
  'const fs = require("node:fs"), assert = require("node:assert/strict");',
  'if (process.env.RAN_MARKER) fs.appendFileSync(process.env.RAN_MARKER, "ran" + String.fromCharCode(10));',
  'const calc = require("./calc.cjs");',
  'const fails = [];',
  'const it = (name, fn) => { try { fn(); } catch (e) { fails.push(" FAIL  src/rules.test.cjs > rules > " + name, "AssertionError: " + String(e.message).split(String.fromCharCode(10))[0]); } };',
  'it("[C1] returns the correct value", () => { const log = []; assert.equal(calc.value(), 2); assert.deepEqual(log, []); });',
  'it("[C2] refuses unauthorized writes", () => { const rows = []; assert.equal(rows.length, 0); });',
  'if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }');
const C1 = ["  it('[C1] returns the correct value', () => {", '    expect(calc.value()).toBe(2);', '  });'];
const C1_QUIET = ["  it('[C1] returns the correct value', () => {", '    const log = [];', '    expect(calc.value()).toBe(2);', '    expect(log).toEqual([]);', '  });'];
const C2 = ["  it('[C2] refuses unauthorized writes', () => {", '    const rows = [];', '    expect(rows).toHaveLength(0);', '  });'];
const HOOK = ['  afterEach(() => {', '    expect(console.error).not.toHaveBeenCalled();', '  });'];
const rulesTest = (...blocks) => lines("describe('rules', () => {", ...blocks.flat(), '});');
const VALUE_WRONG = { name: 'value wrong', file: 'calc.cjs', find: 'value: () => 2', put: 'value: () => 3', mustFail: ['[C1] returns the correct value'] };

test('finding 1: a break that names only [C1] no longer proves the vacuous [C2] check in the same file: refused before any run, the test and its mustFail name said', () => {
  const f = repoWith({ 'calc.cjs': CALC, 'check.cjs': CHECK_RULES }, { 'src/rules.test.cjs': rulesTest(C1, C2) });
  const r = f.proof([VALUE_WRONG], ['--base', 'main', '--then-green', '--parallel', '1']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /UNPROVEN ✗ src\/rules\.test\.cjs: 1 new "nothing happens" check\(s\) whose own test no break here names/);
  assert.match(r.stdout, /src\/rules\.test\.cjs:7 — expect\(rows\)\.toHaveLength\(0\); → its test "\[C2\] refuses unauthorized writes" is named by no caught break: a break of that test's rule whose mustFail names it \("\[C2\] refuses unauthorized writes"\) would prove it/);
  assert.match(r.stdout, /RED-PROOF: NOT PROVED ✗ — .*whose mustFail names the test that holds that check; another caught test in the same file does not count\..*Nothing ran; files untouched\./);
  assert.doesNotMatch(r.stdout, /PROVED ✓|BREAK ✓/);
  assert.equal(f.ran(), 0, 'no run started');
  assert.equal(readRecord(f.repo), null, 'nothing was recorded');
  // The only way through names [C2] in a break of its own rule, and no break can make a vacuous test fail.
  const both = f.proof([VALUE_WRONG, { name: 'writes for anyone', file: 'calc.cjs', find: "rows.push('unauthorized write')", put: "rows.push('unauthorized write', 'again')", mustFail: ['[C2] refuses unauthorized writes'] }],
    ['--base', 'main', '--then-green', '--parallel', '1']);
  assert.equal(both.status, 1, both.stdout + both.stderr);
  assert.match(both.stdout, /BREAK ✓ value wrong/);
  assert.match(both.stdout, /BREAK ✗ writes for anyone: still pass \(or not seen failing\): \[C2\] refuses unauthorized writes/);
  const checked = f.check();
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /UNPROVEN: src\/rules\.test\.cjs:7 /);
});

test('finding 1: the record names the test each break made fail, and the test check counts a check only inside such a test (not another test of the file, not a hook)', () => {
  // The hook and [C2] were committed earlier on this branch; the proof (base: that commit) adds [C1] and names it.
  const f = repoWith({ 'calc.cjs': CALC, 'check.cjs': CHECK_RULES }, { 'src/rules.test.cjs': rulesTest(HOOK, C2) });
  f.git('add', '--all'); f.git('commit', '-qm', 'tests so far');
  f.write({ 'src/rules.test.cjs': rulesTest(HOOK, C1_QUIET, C2) });
  const r = f.proof([VALUE_WRONG], ['--base', 'HEAD', '--then-green', '--parallel', '1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: PROVED ✓ — 1 break\(s\) caught, green on the fix/);
  // Pre-review compares with main: every line of the file is new there.
  const checked = f.check('main');
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /UNPROVEN: src\/rules\.test\.cjs:12 — expect\(rows\)\.toHaveLength\(0\); → its test "\[C2\] refuses unauthorized writes" is named by no caught break: a break of that test's rule whose mustFail names it \("\[C2\] refuses unauthorized writes"\) would prove it/);
  assert.match(checked.stdout, /UNPROVEN: src\/rules\.test\.cjs:3 — expect\(console\.error\)\.not\.toHaveBeenCalled\(\); → the test that holds this line cannot be worked out/);
  assert.doesNotMatch(checked.stdout, /UNPROVEN: src\/rules\.test\.cjs:8 /, 'the check inside the caught test is proven');
  assert.match(checked.stdout, /TEST ASSERTS: 0 range, 2 unproven, 0 untagged, 0 non-null/);
  const [entry] = f.entries();
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.caught, { 'src/rules.test.cjs': [{ line: 5, title: '[C1] returns the correct value', ran: 'src/rules.test.cjs > rules > [C1] returns the correct value', by: 'value wrong' }] },
    'the caught test by its file, line, title and the name the runner printed');
  assert.deepEqual(Object.keys(entry.files), ['src/rules.test.cjs']);
});

test('finding 1: an entry that lists only test files (the record before 2026-11-17) proves no check', () => {
  const f = repoWith({ 'calc.cjs': CALC, 'check.cjs': CHECK_RULES }, { 'src/rules.test.cjs': rulesTest(C1, C2) });
  writeEntry(f.repo, 'older', { ok: true, breaks: 1, files: testFileHashes(f.repo, ['src/rules.test.cjs']), targets: testFileHashes(f.repo, ['calc.cjs']) });
  const checked = f.check();
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /UNPROVEN: src\/rules\.test\.cjs:7 /);
  assert.match(checked.stdout, /a proof record written before 2026-11-17 names no test: run that proof again/);
});

test('the test that holds a line: it(), test(), .each tables, C# facts and theories; a helper, a hook and the top of the file are in no test', async () => {
  const { testSpans, enclosingTest, namedBy } = await import('../scripts/proof-record.mjs');
  const js = [
    "import { render } from './render';",                       // 1
    'const quiet = () => expect(spy).not.toHaveBeenCalled();',  // 2
    "describe('form', () => {",                                 // 3
    '  beforeEach(() => { expect(list).toHaveLength(0); });',   // 4
    "  it('saves nothing', async () => {",                      // 5
    '    expect(api.save).not.toHaveBeenCalled();',             // 6
    '  });',                                                    // 7
    "  it.each([['admin'], ['guest']])('refuses %s', (role) => {", // 8
    '    expect(rows(role)).toEqual([]);',                      // 9
    '  });',                                                    // 10
    '  test.each`',                                             // 11
    '    role',                                                 // 12
    "    ${'admin'}",                                           // 13
    "  `('hides the menu from $role', ({ role }) => {",         // 14
    '    expect(menu(role)).toBeNull();',                       // 15
    '  });',                                                    // 16
    "  it.skip('later', () => { expect(x).toBeNull(); });",     // 17
    '  test(',                                                  // 18
    "    'shows it once',",                                     // 19
    '    () => { expect(count()).toBe(1); },',                  // 20
    '  );',                                                     // 21
    '});',                                                      // 22
  ].join('\r\n'); // line endings do not move a test's lines
  const spans = testSpans(js, 'src/form.test.tsx');
  const at = (line) => { const own = enclosingTest(spans, line); return own && [own.line, own.end, own.titles[0], own.skipped]; };
  assert.deepEqual(at(6), [5, 7, 'saves nothing', false]);
  assert.deepEqual(at(9), [8, 10, 'refuses %s', false], 'a table test keeps its placeholders');
  assert.deepEqual(at(15), [11, 16, 'hides the menu from $role', false], 'a table written as a template');
  assert.deepEqual(at(17), [17, 17, 'later', true], 'a skipped test is found, and marked');
  assert.deepEqual(at(20), [18, 21, 'shows it once', false], 'a title on the next line');
  assert.equal(at(2), null, 'a helper');
  assert.equal(at(4), null, 'a hook');
  assert.equal(at(22), null);
  assert.equal(namedBy(['saves'], enclosingTest(spans, 6)), true);
  assert.equal(namedBy(['later'], enclosingTest(spans, 17)), false, 'a skipped test cannot fail, so no part names it');
  assert.equal(namedBy(['saves'], null), false);
  const cs = [
    'public class RuleTests {',                                          // 1
    '  private void Quiet() { repo.Verify(r => r.Save(), Times.Never); }', // 2
    '  [Fact(DisplayName = "refuses a closed form")]',                   // 3
    '  public async Task Refuses_Closed() {',                            // 4
    '    rows.Should().BeEmpty();',                                      // 5
    '  }',                                                               // 6
    '  [Theory]',                                                        // 7
    '  [InlineData(1)]',                                                 // 8
    '  public void Counts(int n) => Assert.Empty(Rows(n));',             // 9
    '  [Fact(Skip = "flaky")]',                                          // 10
    '  public void Later() { Assert.Null(x); }',                         // 11
    '}',                                                                 // 12
  ].join('\n');
  const csSpans = testSpans(cs, 'Api.Tests/RuleTests.cs');
  const csAt = (line) => { const own = enclosingTest(csSpans, line); return own && [own.line, own.end, own.titles, own.skipped]; };
  assert.deepEqual(csAt(5), [3, 6, ['Refuses_Closed', 'refuses a closed form'], false], 'the method and its DisplayName');
  assert.deepEqual(csAt(9), [7, 9, ['Counts'], false], 'an expression body ends at its ;');
  assert.deepEqual(csAt(11), [10, 11, ['Later'], true]);
  assert.equal(csAt(2), null, 'a helper method is no test');
});

test('the tests a break made fail: only tests a mustFail part names and the runner printed as failing; a row for its table test; never another failing test of the file', async () => {
  const { caughtTests, failureReasons, caughtLine, readCaughtLine } = await import('../scripts/red-proof.mjs');
  const { testSpans } = await import('../scripts/proof-record.mjs');
  const text = ["it('[C1] saves nothing', () => {});", "it('[C1] shows it once', () => {});", "it('[C2] refuses a guest', () => {});",
    "it.each([1, 2])('[C3] refuses row %s', () => {});", "it('[C3] refuses row 9', () => {});"].join('\n');
  const spans = [...testSpans(text, 'web/src/a.test.ts'), ...testSpans("it('[C1] saves nothing', () => {});\n", 'web/src/b.test.ts')];
  const failed = failureReasons([' FAIL  src/b.test.ts > [C1] saves nothing', 'AssertionError: expected 1 to be 0', ' FAIL  src/a.test.ts > form > [C1] saves nothing', 'AssertionError: expected 1 to be 0',
    ' FAIL  src/a.test.ts > form > [C2] refuses a guest', 'AssertionError: expected 1 to be 0', ' FAIL  src/a.test.ts > [C3] refuses row 9', 'AssertionError: expected 1 to be 0',
    ' FAIL  src/a.test.ts > [C3] refuses row 2', 'AssertionError: expected 1 to be 0'].join('\n'));
  const got = (parts) => caughtTests(parts, failed, [], spans).map(t => `${t.file}:${t.line} ${t.title} <- ${t.ran}`).sort();
  assert.deepEqual(got(['saves nothing']), ['web/src/a.test.ts:1 [C1] saves nothing <- src/a.test.ts > form > [C1] saves nothing', 'web/src/b.test.ts:1 [C1] saves nothing <- src/b.test.ts > [C1] saves nothing'],
    'each of two tests with one title takes the failing test printed with its own file; [C2] failed too and is not named');
  assert.deepEqual(got(['[C1]']), got(['saves nothing']), '"[C1] shows it once" is named but did not fail: not caught');
  assert.deepEqual(got(['[C3]']), ['web/src/a.test.ts:4 [C3] refuses row %s <- src/a.test.ts > [C3] refuses row 2', 'web/src/a.test.ts:5 [C3] refuses row 9 <- src/a.test.ts > [C3] refuses row 9'],
    'the written-out title takes its own failing test first; the table test takes a row');
  assert.deepEqual(got(['no such test']), []);
  assert.deepEqual(caughtTests(['[C2]'], failed.map(r => ({ ...r, kind: 'env' })), [], spans), [], 'a failure of the machine catches nothing');
  // A C# test printed by its DisplayName, named by its method (the pairs displayNames gives).
  const cs = testSpans('[Fact(DisplayName = "refuses a closed form")]\npublic void Refuses_Closed() { rows.Should().BeEmpty(); }\n', 'Api.Tests/RuleTests.cs');
  const dotnet = failureReasons(['  Failed refuses a closed form [12 ms]', '  Error Message:', '   Assert.True() Failure'].join('\n'));
  assert.deepEqual(caughtTests(['Refuses_Closed'], dotnet, [{ display: 'refuses a closed form', method: 'Refuses_Closed' }], cs),
    [{ file: 'Api.Tests/RuleTests.cs', line: 1, title: 'refuses a closed form', ran: 'refuses a closed form' }]);
  // What the test machine says about a caught break crosses as one line, whatever a title holds.
  const sent = [{ name: 'src/a.test.ts > form > "يحفظ" > [C1] it\'s saved | once', runner: 'vitest' }, { name: 'Api.Tests.RuleTests.Refuses_Closed', runner: 'dotnet' }];
  const line = caughtLine(3, sent);
  assert.match(line, /^RED-PROOF-CAUGHT: [A-Za-z0-9_-]+$/);
  assert.deepEqual(readCaughtLine(line + '\r'), { i: 3, failed: sent.map(s => ({ ...s, kind: 'other' })) });
  assert.equal(readCaughtLine('  BREAK ✓ one: all 1 named test(s) fail'), null);
  assert.equal(readCaughtLine('RED-PROOF-CAUGHT: not-json'), null);
});

// ---- Finding 2: the audit's fixture. The product returns what its dependency makes of an empty list. ----
const DEPENDENCY = lines('module.exports = { normalize: (items) => items };');
const PRODUCT = (rows) => lines("const dep = require('./dependency.cjs');", `module.exports = { rows: () => dep.normalize(${rows}) };`);
// The harness. Three switches, set from outside the repository, let a later run of the same proof end another way:
// PROOF_MISS (the test no longer notices the break), PROOF_ENV_DOWN (the machine fails), PROOF_KILL (the proof is killed).
const CHECK_ROWS = lines(
  'const fs = require("node:fs"), assert = require("node:assert/strict");',
  'if (process.env.RAN_MARKER) fs.appendFileSync(process.env.RAN_MARKER, "ran" + String.fromCharCode(10));',
  'const product = require("./product.cjs");',
  'const fails = [];',
  'try { assert.deepEqual(product.rows(), []); } catch { fails.push(" FAIL  src/rows.test.cjs > refuses unauthorized rows", "AssertionError: expected the rows to deeply equal []"); }',
  'if (process.env.PROOF_ENV_DOWN) { console.log("Unable to connect to any of the specified MySQL hosts"); process.exit(1); }',
  'if (fails.length && process.env.PROOF_KILL) { process.kill(process.ppid, "SIGKILL"); process.exit(1); }',
  'if (fails.length && !process.env.PROOF_MISS) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }');
const ROWS_TEST = lines("it('refuses unauthorized rows', () => {", '  expect(product.rows()).toEqual([]);', '});');
const ALLOW = { name: 'allow unauthorized rows', file: 'product.cjs', find: 'dep.normalize([])', put: 'dep.normalize(["unauthorized"])', mustFail: ['refuses unauthorized rows'] };
// main holds the bug (a row left in); the working tree holds the fix and its test.
const rowsRepo = () => repoWith({ 'dependency.cjs': DEPENDENCY, 'product.cjs': PRODUCT('["left in"]'), 'check.cjs': CHECK_ROWS, 'docs/guide.md': '# Guide\n' },
  { 'product.cjs': PRODUCT('[]'), 'src/rows.test.cjs': ROWS_TEST });
const full = ['--base', 'main', '--then-green', '--parallel', '1'];
const PROVEN = /TEST ASSERTS: none \(1 "nothing happens" check\(s\) proven by a break run\)/;
function proved(f) {
  const r = f.proof([ALLOW], full);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: PROVED ✓ — 1 break\(s\) caught, green on the fix/);
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, PROVEN);
  const [entry] = f.entries();
  assert.equal(entry.ok, true);
  return entry;
}

test('finding 2: an edit to a dependency (not a break target, not a test file) voids the proof, though the tests stay green; the fresh proof that fails is recorded as not ok', () => {
  const f = rowsRepo();
  const entry = proved(f);
  f.write({ 'dependency.cjs': lines('module.exports = { normalize: () => [] };') });
  assert.equal(spawnSync(process.execPath, ['check.cjs'], { cwd: f.repo, encoding: 'utf8', windowsHide: true, env: env() }).status, 0, 'the tests still pass on the edited dependency');
  const stale = f.check();
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /UNPROVEN: src\/rows\.test\.cjs:2 — expect\(product\.rows\(\)\)\.toEqual\(\[\]\);/);
  assert.match(stale.stdout, /the code changed after a proof ran \(any edit but \*\.md voids it\): run that proof again/);
  assert.match(entry.code, /^[0-9a-f]{40,64}$/, 'the record holds one id of the code under test');
  // The same proof again: the break no longer fails the test.
  const again = f.proof([ALLOW], full);
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stdout, /BREAK ✗ allow unauthorized rows: still pass \(or not seen failing\): refuses unauthorized rows/);
  const [now] = f.entries();
  assert.equal(now.ok, false);
  assert.match(now.reason, /RED-PROOF: NOT PROVED ✗/);
  const after = f.check();
  assert.equal(after.status, 1, after.stdout + after.stderr);
  assert.match(after.stdout, /did not end PROVED \(RED-PROOF: NOT PROVED ✗/);
});

test('finding 2: a prose edit, a commit of the same files and a reworded commit keep the proof; a code edit outside the break targets voids it', () => {
  const f = rowsRepo();
  proved(f);
  // Prose: a tracked .md, a new .md, a new .MD in a folder, in any case.
  f.write({ 'docs/guide.md': '# Guide\n\nMore words.\n', 'NOTES.MD': 'notes\n', 'docs/todo.MD': 'later\n' });
  assert.match(f.check().stdout, PROVEN, 'a prose-only edit keeps the record');
  f.git('add', '--all'); f.git('commit', '-qm', 'the fix');
  let checked = f.check();
  assert.equal(checked.status, 0, 'a commit of the same files keeps the record: ' + checked.stdout);
  assert.match(checked.stdout, PROVEN);
  f.git('commit', '-q', '--amend', '-m', 'fix: refuse unauthorized rows');
  checked = f.check();
  assert.equal(checked.status, 0, 'a reworded commit keeps the record: ' + checked.stdout);
  assert.match(checked.stdout, PROVEN);
  // Code that is neither a break target (product.cjs) nor a test file.
  fs.appendFileSync(path.join(f.repo, 'dependency.cjs'), '// reviewed\n');
  checked = f.check();
  assert.equal(checked.status, 1, 'a code edit outside the targets voids the record: ' + checked.stdout);
  assert.match(checked.stdout, /UNPROVEN: src\/rows\.test\.cjs:2 /);
  // A new code file counts as well; taking the edit back gives the proven code again.
  fs.writeFileSync(path.join(f.repo, 'dependency.cjs'), DEPENDENCY);
  assert.equal(f.check().status, 0, 'the code is the proven code again');
  fs.writeFileSync(path.join(f.repo, 'helper.cjs'), 'module.exports = 1;\n');
  assert.equal(f.check().status, 1, 'a new code file voids the record');
});

test('finding 2: a later run of the same proof on the same code that ends NOT PROVED takes the earlier success back; a run that ends PROVED gives it again', () => {
  const f = rowsRepo();
  proved(f);
  const missed = f.proof([ALLOW], full, { PROOF_MISS: '1' });
  assert.equal(missed.status, 1, missed.stdout + missed.stderr);
  assert.match(missed.stdout, /BREAK ✗ allow unauthorized rows/);
  let [entry] = f.entries();
  assert.equal(f.entries().length, 1, 'the same proof: the same entry');
  assert.equal(entry.ok, false);
  assert.match(entry.reason, /RED-PROOF: NOT PROVED ✗ — see the lines above/);
  const checked = f.check();
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /UNPROVEN: src\/rows\.test\.cjs:2 /);
  assert.match(checked.stdout, /the last run of the proof .* did not end PROVED/);
  proved(f);
});

test('finding 2: a proof that stops on the machine, or is killed mid-run, leaves no earlier success either', () => {
  const f = rowsRepo();
  proved(f);
  const down = f.proof([ALLOW], full, { PROOF_ENV_DOWN: '1' });
  assert.equal(down.status, 6, down.stdout + down.stderr);
  let [entry] = f.entries();
  assert.equal(entry.ok, false);
  assert.match(entry.reason, /RED-PROOF: ENVIRONMENT ✗/);
  assert.equal(f.check().status, 1);
  proved(f);
  // Killed while a break runs in its own copy: no line of its own is said, and no exit handler runs.
  const killed = f.proof([ALLOW], ['--base', 'main', '--then-green', '--parallel', '2'], { PROOF_KILL: '1' });
  assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
  assert.doesNotMatch(killed.stdout, /PROVED|BREAK [✓✗]/, 'it never reached a result');
  [entry] = f.entries();
  assert.equal(entry.ok, false);
  assert.match(entry.reason, /the proof started and did not end/);
  assert.equal(f.check().status, 1);
  assert.equal(f.git('status', '--porcelain', '--', 'product.cjs'), 'M product.cjs', 'the working folder was never touched: only the fix differs from main');
});

test('finding 2: a --changed-since run writes no success and leaves a full proof as it is, unless one of its own runs failed', () => {
  const f = rowsRepo();
  const before = proved(f);
  const partial = f.proof([ALLOW], ['--base', 'main', '--changed-since', 'main', '--then-green', '--parallel', '1']);
  assert.equal(partial.status, 0, partial.stdout + partial.stderr);
  assert.match(partial.stdout, /RED-PROOF: PARTIAL ✓ — 1 of 1 break\(s\) caught, green on the fix/);
  assert.deepEqual(f.entries(), [before], 'a passing partial run does not touch the entry');
  assert.equal(f.check().status, 0);
  const missed = f.proof([ALLOW], ['--base', 'main', '--changed-since', 'main', '--then-green', '--parallel', '1'], { PROOF_MISS: '1' });
  assert.equal(missed.status, 1, missed.stdout + missed.stderr);
  assert.match(missed.stdout, /BREAK ✗ allow unauthorized rows/);
  const [entry] = f.entries();
  assert.deepEqual([entry.ok, entry.partial], [false, true]);
  assert.match(entry.reason, /RED-PROOF: NOT PROVED ✗/);
  assert.equal(f.check().status, 1);
  // A partial run refused before any run (an unknown ref) takes nothing back.
  proved(f);
  const refused = f.proof([ALLOW], ['--base', 'main', '--changed-since', 'no-such-ref', '--then-green']);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.equal(f.entries()[0].ok, true);
});

// ---- The test machine: the machine that asks writes the record ----

test('on the test machine (a plan run) each caught break says the failing tests as its runner named them, and no record is written there', () => {
  const f = rowsRepo();
  f.git('add', '--all'); f.git('commit', '-qm', 'synced');
  const plan = path.join(root, `plan${n}.json`);
  const local = (body) => { fs.writeFileSync(plan, JSON.stringify({ green: true, commit: f.git('rev-parse', 'HEAD'), testFiles: ['src/rows.test.cjs'], ...body }));
    return node(redProof, ['--repo', f.repo, '--local', '--plan', plan, '--base', 'HEAD', '--parallel', '2', '--', process.execPath, 'check.cjs']); };
  const r = local({ breaks: [ALLOW] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /BREAK ✓ allow unauthorized rows/);
  const said = r.stdout.split(/\r?\n/).filter(l => l.startsWith('RED-PROOF-CAUGHT: '));
  assert.equal(said.length, 1, r.stdout);
  assert.deepEqual(JSON.parse(Buffer.from(said[0].slice('RED-PROOF-CAUGHT: '.length), 'base64url').toString('utf8')),
    { i: 0, failed: [{ name: 'src/rows.test.cjs > refuses unauthorized rows', runner: 'vitest' }] });
  assert.equal(readRecord(f.repo), null, 'the plan run leaves the record to the machine that asked');
  const missed = node(redProof, ['--repo', f.repo, '--local', '--plan', plan, '--base', 'HEAD', '--parallel', '2', '--', process.execPath, 'check.cjs'], { PROOF_MISS: '1' });
  assert.equal(missed.status, 1, missed.stdout + missed.stderr);
  assert.doesNotMatch(missed.stdout, /RED-PROOF-CAUGHT/, 'a break that was not caught says no failing test');
});

// ssh and scp that only print what they are given and end with 0: the answer of the "test machine" is written
// into the test command's last word, so it comes back as lines of its own. On Windows the stand-in is Git's own
// echo.exe under those names (a .cmd cannot be started without a shell, and Node under the name ssh stops at -o).
const standIn = (() => {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  if (process.platform !== 'win32') {
    for (const name of ['ssh', 'scp']) { fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf \'%s\\n\' "$*"\n'); fs.chmodSync(path.join(bin, name), 0o755); }
    return { path: bin };
  }
  const tools = gitBash().tools;
  if (!tools || !fs.existsSync(path.join(tools, 'echo.exe'))) return null;
  for (const name of ['ssh', 'scp']) fs.copyFileSync(path.join(tools, 'echo.exe'), path.join(bin, name + '.exe'));
  return { path: bin + path.delimiter + tools }; // its library sits beside the real echo.exe
})();
// A home folder whose remote-sync.sh answers as the real one does: the working tree as one tree, through a
// temporary index. `tree` replaces the tree it names (a sync that sent other code).
function remoteHome(f, tree = '$tree') {
  for (const [k, v] of [['sanad.remoteHost', 'pc-test'], ['sanad.remoteRepo', 'C:/r/repo']]) f.git('config', k, v);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const dir = path.join(home, '.claude', 'scripts', 'remote');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'remote-sync.sh'), ['#!/usr/bin/env bash', 'tmp=$(mktemp -d)', 'export GIT_INDEX_FILE="$tmp/index"', 'git read-tree HEAD', 'git add --all -- . 2>/dev/null',
    'tree=$(git write-tree)', 'unset GIT_INDEX_FILE', 'rm -rf "$tmp"', `echo "SYNCED pc-test $(git rev-parse HEAD) tree ${tree}"`, ''].join('\n'));
  const extra = { HOME: home, USERPROFILE: home };
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  extra[pathKey] = standIn.path + path.delimiter + process.env[pathKey];
  return extra;
}
const answer = (...said) => '\n' + said.join('\n') + '\n';
const CAUGHT_ROWS = 'RED-PROOF-CAUGHT: ' + Buffer.from(JSON.stringify({ i: 0, failed: [{ name: 'src/rows.test.cjs > refuses unauthorized rows', runner: 'vitest' }] })).toString('base64url');

test('a proof sent to the test machine: the machine that asked records the tests the runner there named and the id of its own code as sent', { skip: !standIn && 'no stand-in for ssh on this machine (Git for Windows has no echo.exe)' }, () => {
  const f = rowsRepo();
  const sent = f.proof([ALLOW], ['--base', 'main', '--then-green'], remoteHome(f), ['node', 'check.cjs', answer('  BREAK + allow unauthorized rows: all 1 named test(s) fail', CAUGHT_ROWS)]);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.match(sent.stdout, /RED-PROOF: on pc-test/);
  assert.equal(f.ran(), 0, 'nothing ran on this machine');
  const [entry] = f.entries();
  assert.equal(entry.ok, true);
  assert.equal(entry.remote, 'pc-test');
  assert.deepEqual(entry.caught, { 'src/rows.test.cjs': [{ line: 1, title: 'refuses unauthorized rows', ran: 'src/rows.test.cjs > refuses unauthorized rows', by: 'allow unauthorized rows' }] });
  assert.match(entry.code, /^[0-9a-f]{40,64}$/);
  assert.doesNotMatch(sent.stdout, /^RED-PROOF-CAUGHT/m, 'the line is read, not shown');
  assert.doesNotMatch(sent.stdout, /could not write the proof record/);
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, PROVEN);
  // The code id is of this machine's code as sent: a code edit after it voids the record, here as well.
  fs.appendFileSync(path.join(f.repo, 'dependency.cjs'), '// edited after the proof was sent\n');
  assert.equal(f.check().status, 1);
});

test('a proof sent to the test machine: when the sync sent another tree than this working tree, or the answer names no failing test, nothing is proven', { skip: !standIn && 'no stand-in for ssh on this machine (Git for Windows has no echo.exe)' }, () => {
  const other = rowsRepo();
  // This sync names HEAD's tree, while the working tree holds the uncommitted fix and its test.
  const moved = other.proof([ALLOW], ['--base', 'main', '--then-green'], remoteHome(other, "$(git rev-parse 'HEAD^{tree}')"), ['node', 'check.cjs', answer(CAUGHT_ROWS)]);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout, /RED-PROOF: could not write the proof record — the working tree here \([0-9a-f]{12}\) is not the tree the sync sent \([0-9a-f]{12}\): a file changed while the proof was sent\. Run the proof again\./);
  let [entry] = other.entries();
  assert.equal(entry.ok, false);
  assert.match(entry.reason, /is not the tree the sync sent/);
  assert.equal(other.check().status, 1);
  // An answer with exit 0 that names no failing test: the entry lists no test, so it proves no check.
  const silent = rowsRepo();
  const none = silent.proof([ALLOW], ['--base', 'main', '--then-green'], remoteHome(silent), ['node', 'check.cjs', answer('nothing of note')]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  [entry] = silent.entries();
  assert.deepEqual([entry.ok, entry.caught, entry.files], [true, {}, {}]);
  const checked = silent.check();
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /UNPROVEN: src\/rows\.test\.cjs:2 /);
});

// ---- Repairs after the second audit (2026-11-17) ----

test('repair 1: a failure printed with another test file, or another dotnet class, is never the identity of a new test with the same title', async () => {
  const { caughtTests, failureReasons } = await import('../scripts/red-proof.mjs');
  const { testSpans } = await import('../scripts/proof-record.mjs');
  const newTest = testSpans("it('refuses unauthorized rows', () => { const rows = []; expect(rows).toHaveLength(0); });\n", 'src/b.test.cjs');
  const older = failureReasons(' FAIL  src/a.test.cjs > refuses unauthorized rows\nAssertionError: expected 1 to be 0\n');
  assert.deepEqual(caughtTests(['refuses unauthorized rows'], older, [], newTest), [], 'a.test.cjs failed, b.test.cjs did not');
  const own = failureReasons(' FAIL  src/b.test.cjs > refuses unauthorized rows\nAssertionError: expected 1 to be 0\n');
  assert.equal(caughtTests(['refuses unauthorized rows'], own, [], newTest).length, 1, 'its own file still counts');
  const cs = testSpans('public class NewOrdersTests\n{\n[Fact]\npublic void Refuses_Unauthorized() { x.Should().BeEmpty(); }\n}\n', 'Api.Tests/NewOrdersTests.cs');
  const other = [{ name: 'Api.Tests.OlderOrdersTests.Refuses_Unauthorized', runner: 'dotnet', kind: 'assert' }];
  assert.deepEqual(caughtTests(['Refuses_Unauthorized'], other, [], cs), [], 'another class failed');
  const mine = [{ name: 'Api.Tests.NewOrdersTests.Refuses_Unauthorized', runner: 'dotnet', kind: 'assert' }];
  assert.equal(caughtTests(['Refuses_Unauthorized'], mine, [], cs).length, 1);
  const bare = [{ name: 'Refuses_Unauthorized', runner: 'dotnet', kind: 'assert' }];
  assert.equal(caughtTests(['Refuses_Unauthorized'], bare, [], cs).length, 1, 'a name with no class is still taken');
});

test('repair 3: a regex literal (quote, brace or apostrophe inside) does not lose its test', async () => {
  const { testSpans, closeOf } = await import('../scripts/proof-record.mjs');
  for (const rx of ['expect(css).toMatch(/\\.box\\s*\\{[^}]*margin:\\s*0/);', "expect(screen.getByText(/can't be empty/i)).toBeVisible();"]) {
    const text = ["it('refuses unauthorized rows', () => {", '  ' + rx, '  expect(product.rows()).toEqual([]);', '});', ''].join('\n');
    const [span] = testSpans(text, 'src/rows.test.cjs');
    assert.deepEqual([span.line, span.end, span.titles], [1, 4, ['refuses unauthorized rows']], rx);
  }
  // A division is not a regex, and a call the reader cannot close still ends before the next test.
  assert.equal(closeOf('f(a / b, "x/")', 1), 13);
  const lost = ["it('one', () => {", '  const s = `unclosed;', '  expect(a).toEqual([]);', '});', "it('two', () => {});", ''].join('\n');
  const spans = testSpans(lost, 'src/x.test.cjs');
  assert.ok(spans.length >= 1 && spans[0].titles[0] === 'one' && spans[0].end >= 3, JSON.stringify(spans));
});

const HELPER_TEST = lines('const expectNoRows = (rows) => {', '  expect(rows).toEqual([]);', '};', "it('refuses unauthorized rows', () => {", '  expectNoRows(product.rows());', '});');
test('repair 4: a new check in a helper counts when a caught test calls the helper; a helper no caught test calls, and a hook, stay unproven', () => {
  const base = { 'dependency.cjs': DEPENDENCY, 'product.cjs': PRODUCT('["left in"]'), 'check.cjs': CHECK_ROWS };
  const f = repoWith(base, { 'product.cjs': PRODUCT('[]'), 'src/rows.test.cjs': HELPER_TEST });
  const r = f.proof([ALLOW], full);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const checked = f.check();
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, PROVEN);
  const lone = repoWith(base, { 'product.cjs': PRODUCT('[]'), 'src/rows.test.cjs': lines('const expectNoRows = (rows) => {', '  expect(rows).toEqual([]);', '};', "it('refuses unauthorized rows', () => {", '  expect(product.rows()).toEqual([]);', '});') });
  const l = lone.proof([ALLOW], full);
  assert.equal(l.status, 2, l.stdout + l.stderr);
  assert.match(l.stdout, /UNPROVEN ✗ src\/rows\.test\.cjs: 1 /);
  const hook = repoWith(base, { 'product.cjs': PRODUCT('[]'), 'src/rows.test.cjs': lines('afterEach(() => {', '  expect(console.error).not.toHaveBeenCalled();', '});', "it('refuses unauthorized rows', () => {", '  expect(product.rows()).toEqual([]);', '});') });
  assert.equal(hook.proof([ALLOW], full).status, 2);
});

test('repair 2: a --changed-since run that stopped on the machine (not on a test) leaves a full proof as it is', () => {
  const f = rowsRepo();
  const before = proved(f);
  const down = f.proof([ALLOW], ['--base', 'main', '--changed-since', 'main', '--then-green', '--parallel', '1'], { PROOF_ENV_DOWN: '1' });
  assert.notEqual(down.status, 0, down.stdout + down.stderr);
  assert.deepEqual(f.entries(), [before], 'the entry is untouched');
  assert.equal(f.check().status, 0);
});

test('repair 5: on the test machine a test named with an env value still comes back by its real name', () => {
  const f = rowsRepo();
  f.git('add', '--all'); f.git('commit', '-qm', 'synced');
  const envFile = path.join(root, `test${n}.env`);
  fs.writeFileSync(envFile, 'APP_ROLE=unauthorized\n');
  const plan = path.join(root, `plan5-${n}.json`);
  fs.writeFileSync(plan, JSON.stringify({ green: true, commit: f.git('rev-parse', 'HEAD'), testFiles: ['src/rows.test.cjs'], breaks: [ALLOW] }));
  const r = node(redProof, ['--repo', f.repo, '--local', '--plan', plan, '--base', 'HEAD', '--parallel', '2', '--test-env', envFile, '--', process.execPath, 'check.cjs']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const said = r.stdout.split(/\r?\n/).filter(l => l.startsWith('RED-PROOF-CAUGHT: '));
  assert.equal(said.length, 1, r.stdout);
  assert.deepEqual(JSON.parse(Buffer.from(said[0].slice('RED-PROOF-CAUGHT: '.length), 'base64url').toString('utf8')).failed,
    [{ name: 'src/rows.test.cjs > refuses unauthorized rows', runner: 'vitest' }]);
});

test('repair 6: an edit to a .txt file the product may read voids the proof; a .md edit keeps it', () => {
  const f = rowsRepo();
  proved(f);
  f.write({ 'docs/guide.md': '# Guide\n\nMore.\n' });
  assert.equal(f.check().status, 0);
  f.write({ 'rules.txt': 'off\n' });
  const stale = f.check();
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /the code changed after a proof ran/);
});

test('repair 7: a new vacuous check in a test file whose path holds a space is seen', () => {
  const f = repoWith({ 'my tests/rows.test.cjs': ROWS_TEST, 'product.cjs': PRODUCT('[]'), 'dependency.cjs': DEPENDENCY });
  fs.appendFileSync(path.join(f.repo, 'my tests/rows.test.cjs'), "it('vacuous', () => { const rows = []; expect(rows).toHaveLength(0); });\n");
  const checked = f.check();
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /UNPROVEN: my tests\/rows\.test\.cjs:4 /);
});
