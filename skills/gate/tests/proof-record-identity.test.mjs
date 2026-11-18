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

// ---- Repairs after the third audit (2026-11-18, its findings 4 and 5) ----

test('finding 4: a helper counts only when executable code of a test calls it: not a comment, not the text of a string or template; a real call, also inside a ${} hole, still counts', async () => {
  const { testSpans, helperCallers } = await import('../scripts/proof-record.mjs');
  const callers = (body, file = 'src/rows.test.cjs') => {
    const text = lines('const expectNoRows = (rows) => {', '  expect(rows).toEqual([]);', '};', "it('refuses unauthorized rows', () => {", ...body, '});');
    return helperCallers(text, testSpans(text, file), 2).length;
  };
  assert.equal(callers(['  expectNoRows(product.rows());']), 1, 'a real call');
  assert.equal(callers(['  // expectNoRows(product.rows());', '  expect(product.rows()).toEqual([]);']), 0, 'a line comment');
  assert.equal(callers(['  /* expectNoRows(product.rows()); */', '  expect(product.rows()).toEqual([]);']), 0, 'a block comment');
  assert.equal(callers(['  /*', '   expectNoRows(product.rows());', '  */']), 0, 'a block comment over lines');
  assert.equal(callers(['  const s = "expectNoRows(rows)";']), 0, 'a double-quoted string');
  assert.equal(callers(["  const s = 'expectNoRows(rows)';"]), 0, 'a single-quoted string');
  assert.equal(callers(['  const s = `expectNoRows(rows) and more`;']), 0, 'a template literal');
  assert.equal(callers(['  const s = `a ${1} expectNoRows(rows) ${2}`;']), 0, 'text between two holes');
  assert.equal(callers(['  const s = `x ${expectNoRows(product.rows())} y`;']), 1, 'a call inside a template hole runs');
  assert.equal(callers(['  const s = "it\'s", t = "// expectNoRows(rows)";', '  expectNoRows(product.rows());']), 1, 'a quote or slashes in a string do not hide the next real call');
  assert.equal(callers(['  const re = /expectNoRows\\(/;']), 0, 'a regex literal');
  assert.equal(callers(["  const url = 'http://x'; expectNoRows(product.rows());"]), 1, '// inside a string is no comment');
  // A commented-out helper declaration is no helper: the line is in no helper, so no test is its caller.
  const dead = lines('// const expectNoRows = (rows) => {', '  expect(rows).toEqual([]);', '// };', "it('refuses unauthorized rows', () => {", '  expectNoRows(product.rows());', '});');
  assert.deepEqual(helperCallers(dead, testSpans(dead, 'src/rows.test.cjs'), 2), []);
  // C#
  const cs = (body) => {
    const text = lines('public class RowsTests {', 'private static void ExpectNoRows(List<int> rows)', '{', '    rows.Should().BeEmpty();', '}', '[Fact]', 'public void Refuses_Unauthorized()', '{', ...body, '}', '}');
    return helperCallers(text, testSpans(text, 'Api.Tests/RowsTests.cs'), 4).length;
  };
  assert.equal(cs(['    ExpectNoRows(rows);']), 1, 'a real C# call');
  assert.equal(cs(['    // ExpectNoRows(rows);', '    Assert.True(true);']), 0, 'a C# line comment');
  assert.equal(cs(['    /* ExpectNoRows(rows); */']), 0, 'a C# block comment');
  assert.equal(cs(['    var s = "ExpectNoRows(rows)";']), 0, 'a C# string');
  assert.equal(cs(['    var s = @"say ""x"" ExpectNoRows(rows)";']), 0, 'a verbatim string with doubled quotes');
  assert.equal(cs(['    var s = $"a {ExpectNoRows(rows)} b";']), 1, 'a call in an interpolation hole runs');
  assert.equal(cs(['    var s = $"a {{ExpectNoRows(rows)}} b";']), 0, 'doubled braces are text');
  assert.equal(cs(["    var c = '\"'; ExpectNoRows(rows);"]), 1, 'a quote char literal does not open a string');
  assert.equal(cs(['    var s = """', '      ExpectNoRows(rows)', '    """;']), 0, 'a raw string');
});

test('finding 4: a commented-out or quoted test call is no test and no [Fact]; the limit (a conditional call counts) is written where the rule lives', async () => {
  const { testSpans } = await import('../scripts/proof-record.mjs');
  const text = lines("// it('ghost', () => {", "const s = \"it('also a ghost', () => {})\";", "it('real', () => {", '  expect(1).toBe(1);', '});');
  assert.deepEqual(testSpans(text, 'a.test.cjs').map(s => s.titles[0]), ['real']);
  const cs = lines('// [Fact]', 'public void Ghost() { }', '[Fact]', 'public void Real() { }');
  assert.deepEqual(testSpans(cs, 'A.cs').map(s => s.titles[0]), ['Real']);
  assert.match(fs.readFileSync(path.join(scripts, 'proof-record.mjs'), 'utf8'), /cannot prove that a conditional assertion ran/);
});

test('finding 4: a commented call to a helper that checks zero writes does not prove the helper check: refused before any run', () => {
  const base = { 'dependency.cjs': DEPENDENCY, 'product.cjs': PRODUCT('["left in"]'), 'check.cjs': CHECK_ROWS };
  const f = repoWith(base, { 'product.cjs': PRODUCT('[]'), 'src/rows.test.cjs': lines('const expectNoRows = (rows) => {', '  expect(rows).toEqual([]);', '};', "it('refuses unauthorized rows', () => {", '  // expectNoRows(product.rows());', '  expect(product.rows()).toEqual([]);', '});') });
  const r = f.proof([ALLOW], full);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /UNPROVEN ✗ src\/rows\.test\.cjs: 1 /);
});

test('finding 5: the class of a C# test is the class whose braces hold it, not the last `class X` written above it (a closed nested class, a comment or a string that says class)', async () => {
  const { testSpans } = await import('../scripts/proof-record.mjs');
  const text = lines('namespace Demo;', 'public class ServiceTests', '{', '    private class FakeHandler', '    {', '        public string Name => "class Nope {";', '    }', '    // class CommentClass {', '    private const string S = "class StringClass {";', '', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '', '    public class InnerTests', '    {', '        [Fact]', '        public void InnerRefuses() { x.Should().BeEmpty(); }', '    }', '', '    [Fact]', '    public void AfterInner() { x.Should().BeEmpty(); }', '}', '', 'public class OtherTests', '{', '    [Fact]', '    public void OtherRefuses() { x.Should().BeEmpty(); }', '}');
  const got = Object.fromEntries(testSpans(text, 'Api.Tests/ServiceTests.cs').map(s => [s.titles[0], s.klass]));
  assert.deepEqual(got, { RefusesUnauthorized: 'ServiceTests', InnerRefuses: 'InnerTests', AfterInner: 'ServiceTests', OtherRefuses: 'OtherTests' });
});

test('finding 5: the result that is shown (survivors) and the record that is saved (caughtTests) take the same identity: the failure of the right class, found past a closed nested class; another class is not it', async () => {
  const { survivors, caughtTests, failureReasons } = await import('../scripts/red-proof.mjs');
  const { testSpans, declaredTests } = await import('../scripts/proof-record.mjs');
  const text = lines('public class ServiceTests', '{', '    private class FakeHandler', '    {', '        public int X => 1;', '    }', '', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '}');
  const file = 'Api.Tests/ServiceTests.cs';
  const own = failureReasons('  Failed Demo.ServiceTests.RefusesUnauthorized [12 ms]\n  Error Message:\n   Assert.True() Failure\n');
  const wrong = failureReasons('  Failed Demo.FakeHandler.RefusesUnauthorized [12 ms]\n  Error Message:\n   Assert.True() Failure\n');
  const spans = testSpans(text, file), declared = declaredTests(text, file);
  assert.deepEqual(survivors(['RefusesUnauthorized'], own, [], declared), []);
  assert.equal(caughtTests(['RefusesUnauthorized'], own, [], spans).length, 1, 'the record holds the test the result shows caught');
  assert.equal(survivors(['RefusesUnauthorized'], wrong, [], declared).length, 1, 'a failure of another class is not this test: shown as not failing');
  assert.deepEqual(caughtTests(['RefusesUnauthorized'], wrong, [], spans), [], 'and not saved');
  // A failure printed with another test file is not a vitest test of this file, in the result as in the record.
  const js = "it('refuses unauthorized rows', () => { expect(1).toBe(2); });\n";
  const other = failureReasons(' FAIL  src/a.test.cjs > refuses unauthorized rows\nAssertionError: expected 1 to be 0\n');
  assert.equal(survivors(['refuses unauthorized rows'], other, [], declaredTests(js, 'src/b.test.cjs')).length, 1);
  assert.deepEqual(caughtTests(['refuses unauthorized rows'], other, [], testSpans(js, 'src/b.test.cjs')), []);
  const mine = failureReasons(' FAIL  src/b.test.cjs > refuses unauthorized rows\nAssertionError: expected 1 to be 0\n');
  assert.deepEqual(survivors(['refuses unauthorized rows'], mine, [], declaredTests(js, 'src/b.test.cjs')), []);
});

// ---- Repair round 2026-11-18 (seven confirmed findings on the first repair of audit findings 4 and 5) ----

test('repair finding 1: a wrapper call (await waitFor(() => {, return act(() => {, await WithDbAsync(async db =>) is no helper declaration: only a real declaration names the helper', async () => {
  const { testSpans, helperCallers } = await import('../scripts/proof-record.mjs');
  const js = lines('const expectNoRows = async () => {', '  await waitFor(() => {', '    expect(calc.rows()).toEqual([]);', '  });', '};', "it('returns the correct value', async () => {", '  await waitFor(() => expect(calc.value()).toBe(2));', '});');
  assert.deepEqual(helperCallers(js, testSpans(js, 'src/rows.test.cjs'), 3), [], 'no test calls expectNoRows');
  const js2 = lines('const expectNoRows = async () => {', '  await waitFor(() => {', '    expect(calc.rows()).toEqual([]);', '  });', '};', "it('refuses', async () => {", '  await expectNoRows();', '});');
  assert.equal(helperCallers(js2, testSpans(js2, 'src/rows.test.cjs'), 3).length, 1, 'the real helper still has its caller');
  const act = lines('function expectNoRows() {', '  return act(() => {', '    expect(calc.rows()).toEqual([]);', '  });', '}', "it('returns the correct value', () => {", '  return act(() => calc.value());', '});');
  assert.deepEqual(helperCallers(act, testSpans(act, 'src/rows.test.cjs'), 3), []);
  const hook = lines("beforeEach(async () => {", '  await waitFor(() => {', '    expect(calc.rows()).toEqual([]);', '  });', '});', "it('returns the correct value', async () => {", '  await waitFor(() => expect(calc.value()).toBe(2));', '});');
  assert.deepEqual(helperCallers(hook, testSpans(hook, 'src/rows.test.cjs'), 3), []);
  const cs = lines('public class RowsTests', '{', '    private async Task AssertNoRowsAsync()', '    {', '        await WithDbAsync(async db =>', '        {', '            Assert.Empty(db.Rows);', '        });', '    }', '', '    [Fact]', '    public async Task Saves_Row()', '    {', '        await WithDbAsync(async db => { db.Save(); });', '    }', '}');
  assert.deepEqual(helperCallers(cs, testSpans(cs, 'Api.Tests/RowsTests.cs'), 7), [], 'C#: no test calls AssertNoRowsAsync');
  const cs2 = cs.replace('db.Save(); });', 'db.Save(); });\n        await AssertNoRowsAsync();');
  assert.equal(helperCallers(cs2, testSpans(cs2, 'Api.Tests/RowsTests.cs'), 7).length, 1, 'C#: the real helper still has its caller');
});

test('repair finding 2: a C# verbatim string that starts with a doubled quote (@"""x"" y") is not a raw string: the tests after it stay tests; an unclosed literal keeps the raw text so tests cannot vanish', async () => {
  const { testSpans, declaredTests, executableText, helperCallers } = await import('../scripts/proof-record.mjs');
  const make = (decl) => lines('namespace Demo;', 'public class ServiceTests', '{', decl, '', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '', '    [Fact]', '    public void RefusesUnauthorized_ForGuest() { x.Should().BeEmpty(); }', '}');
  for (const decl of ['    private const string Cmd = @"""C:\\tools\\run.exe"" --quiet";', '    private const string Cmd = @"""";', '    private const string H = @"""Full Name"",Email";', '    private const string H = $@"""{1}"" x";']) {
    const text = make(decl);
    assert.equal(declaredTests(text, 'Api.Tests/ServiceTests.cs').length, 2, decl);
    assert.equal(testSpans(text, 'Api.Tests/ServiceTests.cs').length, 2, decl);
  }
  // A raw string (no @) still hides its text.
  assert.doesNotMatch(executableText('var s = """\n  ExpectNoRows(rows)\n""";\n', 'A.cs'), /ExpectNoRows/);
  // Safety net: a literal with no end keeps the raw text from its start, so declarations after it are still seen.
  const open = lines('public class T', '{', '    private const string S = @"never closed;', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '}');
  assert.equal(testSpans(open, 'Api.Tests/T.cs').length, 1);
  const tpl = lines("const s = `never closed;", "it('first', () => {});", "it('second', () => {});");
  assert.equal(declaredTests(tpl, 'a.test.ts').length, 2);
  // A real helper call after a verbatim string with doubled quotes is counted.
  const call = lines('public class RowsTests', '{', '    private const string H = @"""Full Name"",Email";', '    private static void ExpectNoRows(List<int> rows)', '    {', '        rows.Should().BeEmpty();', '    }', '    [Fact]', '    public void Refuses_Unauthorized()', '    {', '        ExpectNoRows(rows);', '    }', '}');
  assert.equal(helperCallers(call, testSpans(call, 'Api.Tests/RowsTests.cs'), 6).length, 1);
});

test('repair finding 3: a regex literal after return, typeof, case, throw, yield, await, void, in, of, do or else is a regex: a backtick in it opens no template', async () => {
  const { declaredTests, testSpans, helperCallers, closeOf } = await import('../scripts/proof-record.mjs');
  for (const kw of ['return', 'typeof', 'case', 'throw', 'yield', 'await', 'void', 'do', 'else']) {
    const text = lines(`const isTick = (c) => { ${kw} /\`/.test(c); };`, "it('first [C1] refuses', () => {});", "it('second [C1] refuses', () => {});");
    assert.equal(declaredTests(text, 'a.test.ts').length, 2, kw);
  }
  const text = lines('const expectNoRows = (rows) => {', '  expect(rows).toEqual([]);', '};', "it('refuses', () => {", '  const isTick = (c) => { return /`/.test(c); };', '  expectNoRows(product.rows());', '});');
  assert.equal(helperCallers(text, testSpans(text, 'a.test.ts'), 2).length, 1);
  // closeOf reads it the same way.
  const src = "{ return /`/.test(c); }";
  assert.equal(closeOf(src, 0), src.length - 1);
  // Division after an identifier is still division, not a regex.
  const div = lines('const r = a / b; const s = c / d;', "it('a', () => {});");
  assert.equal(declaredTests(div, 'a.test.ts').length, 1);
});

test('repair finding 4: a test of an abstract base class (or a class another class derives from) is printed by the runner with the derived class: that is the same test', async () => {
  const { survivors, caughtTests, failureReasons } = await import('../scripts/red-proof.mjs');
  const { testSpans, declaredTests, csClassList } = await import('../scripts/proof-record.mjs');
  const base = lines('namespace Demo;', 'public abstract class ServiceTestsBase', '{', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '}');
  const file = 'Api.Tests/ServiceTestsBase.cs';
  const derived = failureReasons('  Failed Demo.SqlServiceTests.RefusesUnauthorized [12 ms]\n  Error Message:\n   Assert.True() Failure\n');
  // Changed 2026-11-18 (round 3): the derived class must be known from the test files read (here its class list is
  // passed); with none known the failure is not credited (see round 3 problem 2).
  const sqlClasses = csClassList('public class SqlServiceTests : ServiceTestsBase { }', 'Api.Tests/SqlServiceTests.cs');
  assert.deepEqual(survivors(['RefusesUnauthorized'], derived, [], declaredTests(base, file), sqlClasses), []);
  assert.equal(caughtTests(['RefusesUnauthorized'], derived, [], testSpans(base, file), sqlClasses).length, 1);
  // A plain base class that a class in the same file names as its base is open the same way.
  const plain = lines('public class Shared<T> where T : class', '{', '    [Fact]', '    public void Refuses() { x.Should().BeEmpty(); }', '}', 'public sealed class Sql : Shared<int>, IDisposable', '{', '}');
  const printed = failureReasons('  Failed Demo.Sql.Refuses [12 ms]\n  Error Message:\n   Assert.True() Failure\n');
  assert.deepEqual(survivors(['Refuses'], printed, [], declaredTests(plain, 'A.cs')), []);
  // A plain class nobody derives from still needs its own class name.
  const closed = lines('public class ServiceTests', '{', '    [Fact]', '    public void Refuses() { x.Should().BeEmpty(); }', '}', 'public class Other', '{', '}');
  const wrong = failureReasons('  Failed Demo.Other.Refuses [12 ms]\n  Error Message:\n   Assert.True() Failure\n');
  assert.equal(survivors(['Refuses'], wrong, [], declaredTests(closed, 'A.cs')).length, 1);
});

test('repair finding 5: a custom fact attribute ([SkippableFact], [MySqlFact], [AttemptMySqlFact(...)]) makes a test, as [Fact] and [Theory] do', async () => {
  const { testSpans, declaredTests, enclosingTest, skippedLines } = await import('../scripts/proof-record.mjs');
  const text = lines('public class DbTests', '{', '    [SkippableFact]', '    public async Task Refuses_OnMySql()', '    {', '        rows.Should().BeEmpty();', '    }', '', '    [MySqlTheory(Skip = "no db")]', '    [InlineData(1)]', '    public void Skipped_OnMySql(int x) { }', '', '    [Xunit.Fact]', '    public void Qualified() { }', '}');
  const file = 'Api.Tests/DbTests.cs';
  const spans = testSpans(text, file);
  assert.deepEqual(spans.map(s => s.titles[0]), ['Refuses_OnMySql', 'Skipped_OnMySql', 'Qualified']);
  assert.equal(enclosingTest(spans, 6)?.titles[0], 'Refuses_OnMySql');
  assert.deepEqual(declaredTests(text, file).map(d => d.titles[0]), ['Refuses_OnMySql', 'Qualified']);
  assert.ok(skippedLines(text, file).has(11));
  // Not an attribute of a test: a name that only holds the word.
  assert.equal(testSpans(lines('[Description("Fact")]', 'public void NotATest() { }'), file).length, 0);
});

test('repair finding 6: a [Theory] row whose argument text holds a parenthesis is matched to its test', async () => {
  const { survivors, caughtTests, failureReasons } = await import('../scripts/red-proof.mjs');
  const { testSpans, declaredTests } = await import('../scripts/proof-record.mjs');
  const text = lines('public class ServiceTests', '{', '    [Theory]', '    [InlineData("a (b)")]', '    public void Refuses(string role) { }', '}');
  const file = 'Api.Tests/ServiceTests.cs';
  const reasons = failureReasons('  Failed Demo.ServiceTests.Refuses(role: "a (b)") [1 ms]\n  Error Message:\n   Assert.True() Failure\n');
  assert.deepEqual(survivors(['Refuses'], reasons, [], declaredTests(text, file)), []);
  assert.equal(caughtTests(['Refuses'], reasons, [], testSpans(text, file)).length, 1);
  const other = failureReasons('  Failed Demo.Other.Refuses(role: "a (b)") [1 ms]\n  Error Message:\n   Assert.True() Failure\n');
  assert.equal(survivors(['Refuses'], other, [], declaredTests(text, file)).length, 1, 'the class is still checked');
});

test('repair finding 7: a helper call inside a C# #if false ... #endif block is no call; the live branch (#else) still counts', async () => {
  const { testSpans, helperCallers, executableText } = await import('../scripts/proof-record.mjs');
  const cs = (body) => {
    const text = lines('public class RowsTests {', 'private static void ExpectNoRows(List<int> rows)', '{', '    rows.Should().BeEmpty();', '}', '[Fact]', 'public void Refuses_Unauthorized()', '{', ...body, '}', '}');
    return helperCallers(text, testSpans(text, 'Api.Tests/RowsTests.cs'), 4).length;
  };
  assert.equal(cs(['#if false', '    ExpectNoRows(rows);', '#endif', '    Assert.True(true);']), 0);
  assert.equal(cs(['#if false', '    ExpectNoRows(rows);', '#else', '    Assert.True(true);', '#endif']), 0);
  assert.equal(cs(['#if false', '    Assert.True(true);', '#else', '    ExpectNoRows(rows);', '#endif']), 1, 'the #else branch of #if false is live');
  assert.equal(cs(['#if false', '#if DEBUG', '    Assert.True(true);', '#endif', '    ExpectNoRows(rows);', '#endif', '    Assert.True(true);']), 0, 'a nested #if inside the dead block');
  assert.equal(cs(['#if DEBUG', '    ExpectNoRows(rows);', '#endif']), 1, 'other conditions are named in the limit, not decided');
  assert.equal(cs(['    ExpectNoRows(rows);']), 1);
  // Same length, same lines.
  const t = '#if false\r\nA();\r\n#endif\r\nB();\r\n';
  const e = executableText(t, 'A.cs');
  assert.equal(e.length, t.length);
  assert.equal(e.split('\n').length, t.split('\n').length);
  assert.match(fs.readFileSync(path.join(scripts, 'proof-record.mjs'), 'utf8'), /#if/);
});

// ---- Repair round 2026-11-18 (two more confirmed problems) ----

test('round 3 problem 1: a call counts only when it can be the helper itself: not a member of another object, not a shadowing local declaration, not a regex literal', async () => {
  const { testSpans, helperCallers } = await import('../scripts/proof-record.mjs');
  const js = (body) => { const t = lines('function expectNoRows(rows) {', '  expect(rows).toEqual([]);', '}', "it('refuses', () => {", ...body, '});'); return helperCallers(t, testSpans(t, 'src/rows.test.cjs'), 2).length; };
  assert.equal(js(['  other.expectNoRows(product.rows());']), 0, 'a member of another object');
  assert.equal(js(['  other?.expectNoRows(product.rows());']), 0, 'an optional member of another object');
  assert.equal(js(['  a.b.expectNoRows(product.rows());']), 0, 'a chained member');
  assert.equal(js(['  make().expectNoRows(product.rows());']), 0, 'a member of a call result');
  assert.equal(js(['  function expectNoRows() {}', '  expectNoRows(product.rows());']), 0, 'a local function of the same name');
  assert.equal(js(['  const expectNoRows = () => {};', '  expectNoRows(product.rows());']), 0, 'a local const of the same name');
  assert.equal(js(['  let expectNoRows = noop;', '  expectNoRows(product.rows());']), 0, 'a local let of the same name');
  assert.equal(js(['  if (true) /expectNoRows(rows)/.test(x);']), 0, 'a regex literal after if (true)');
  assert.equal(js(['  while (go()) /expectNoRows(rows)/.test(x);']), 0, 'a regex literal after while (...)');
  // Must not change: the nearest normal flows still count.
  assert.equal(js(['  expectNoRows(product.rows());']), 1, 'a plain call');
  assert.equal(js(['  await expectNoRows(product.rows());']), 1, 'an awaited call');
  assert.equal(js(['  this.expectNoRows(product.rows());']), 1, 'a call on this');
  assert.equal(js(['  expect(other.rows()).toEqual([]);', '  expectNoRows(product.rows());']), 1, 'a call after another object member call');
  assert.equal(js(['  const total = (a + b) / expectNoRows(rows) / 2;']), 1, 'a division is not a regex');
  assert.equal(js(['  if (ready) expectNoRows(rows);']), 1, 'a call after if (...)');
  // A shadow in one test does not hide the real call of another test.
  const two = lines('function expectNoRows(rows) {', '  expect(rows).toEqual([]);', '}', "it('shadows', () => {", '  const expectNoRows = () => {};', '  expectNoRows(rows);', '});', "it('calls', () => {", '  expectNoRows(rows);', '});');
  assert.deepEqual(helperCallers(two, testSpans(two, 'src/rows.test.cjs'), 2).map(s => s.titles[0]), ['calls']);
  // C#: another object's method, a local function of the same name; the class itself and this still count.
  const cs = (body) => { const t = lines('public class RowsTests', '{', '    private static void ExpectNoRows(List<int> rows)', '    {', '        rows.Should().BeEmpty();', '    }', '', '    [Fact]', '    public void Refuses_Unauthorized()', '    {', ...body, '    }', '}'); return helperCallers(t, testSpans(t, 'Api.Tests/RowsTests.cs'), 5).length; };
  assert.equal(cs(['        Other.ExpectNoRows(rows);']), 0, 'C#: a member of another class');
  assert.equal(cs(['        helper.ExpectNoRows(rows);']), 0, 'C#: a member of another object');
  assert.equal(cs(['        void ExpectNoRows(List<int> r) { }', '        ExpectNoRows(rows);']), 0, 'C#: a local function of the same name');
  assert.equal(cs(['        var ExpectNoRows = (List<int> r) => { };', '        ExpectNoRows(rows);']), 0, 'C#: a local variable of the same name');
  assert.equal(cs(['        ExpectNoRows(rows);']), 1, 'C#: a plain call');
  assert.equal(cs(['        RowsTests.ExpectNoRows(rows);']), 1, 'C#: a call on the declaring class');
  assert.equal(cs(['        this.ExpectNoRows(rows);']), 1, 'C#: a call on this');
});

test('round 3 problem 2: an inherited test is credited only by a failing test whose class is known to derive from the declaring class, across the files read', async () => {
  const { survivors, caughtTests, failureReasons } = await import('../scripts/red-proof.mjs');
  const { testSpans, declaredTests, csClassList } = await import('../scripts/proof-record.mjs');
  const base = lines('namespace Demo;', 'public abstract class BaseTests', '{', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '}');
  const unrelated = lines('namespace Demo;', 'public class UnrelatedTests', '{', '    [Fact]', '    public void Other() { x.Should().BeEmpty(); }', '}');
  const sql = lines('namespace Demo;', 'public class SqlTests : BaseTests', '{', '    [Fact]', '    public void Own() { x.Should().BeEmpty(); }', '}');
  const mid = lines('namespace Demo;', 'public abstract class MidTests : BaseTests', '{', '    [Fact]', '    public void MidOwn() { x.Should().BeEmpty(); }', '}');
  const leaf = lines('namespace Demo;', 'public class LeafTests : MidTests', '{', '    [Fact]', '    public void LeafOwn() { x.Should().BeEmpty(); }', '}');
  const fail = (cls) => failureReasons(`  Failed Demo.${cls}.RefusesUnauthorized [12 ms]\n  Error Message:\n   Assert.True() Failure\n`);
  const decl = (...files) => files.flatMap(([t, f]) => declaredTests(t, f)), spans = (...files) => files.flatMap(([t, f]) => testSpans(t, f));
  const B = [base, 'Api.Tests/BaseTests.cs'], U = [unrelated, 'Api.Tests/UnrelatedTests.cs'], S = [sql, 'Api.Tests/SqlTests.cs'], M = [mid, 'Api.Tests/MidTests.cs'], L = [leaf, 'Api.Tests/LeafTests.cs'];
  // The unrelated class: not credited, with another class known (and without).
  for (const files of [[B, U], [B]]) {
    assert.equal(survivors(['RefusesUnauthorized'], fail('UnrelatedTests'), [], decl(...files)).length, 1, 'shown: not credited');
    assert.deepEqual(caughtTests(['RefusesUnauthorized'], fail('UnrelatedTests'), [], spans(...files)), [], 'saved: not credited');
  }
  // Derived in another file (it has tests of its own): credited.
  assert.deepEqual(survivors(['RefusesUnauthorized'], fail('SqlTests'), [], decl(B, S)), []);
  assert.equal(caughtTests(['RefusesUnauthorized'], fail('SqlTests'), [], spans(B, S)).length, 1);
  assert.equal(survivors(['RefusesUnauthorized'], fail('UnrelatedTests'), [], decl(B, S, U)).length, 1, 'derived known, but the failing class is not it');
  // Derived through another class, three files.
  assert.deepEqual(survivors(['RefusesUnauthorized'], fail('LeafTests'), [], decl(B, M, L)), []);
  assert.equal(caughtTests(['RefusesUnauthorized'], fail('LeafTests'), [], spans(B, M, L)).length, 1);
  // A derived class in a file with no test: its class list is passed.
  const noTests = csClassList('public class SqlTests : BaseTests { }', 'Api.Tests/SqlTests.cs');
  assert.deepEqual(survivors(['RefusesUnauthorized'], fail('SqlTests'), [], decl(B), noTests), []);
  assert.equal(caughtTests(['RefusesUnauthorized'], fail('SqlTests'), [], spans(B), noTests).length, 1);
  // No derived class known at all: the honest path says it cannot be matched and names the base class.
  const left = survivors(['RefusesUnauthorized'], fail('SqlTests'), [], decl(B));
  assert.equal(left.length, 1);
  assert.match(left[0], /cannot be matched/);
  assert.match(left[0], /BaseTests/);
  // Must not change: a test of its own class is credited by that class, and nested names still work.
  assert.deepEqual(survivors(['RefusesUnauthorized'], fail('BaseTests'), [], decl(B)), []);
  assert.deepEqual(survivors(['RefusesUnauthorized'], failureReasons('  Failed Demo.Outer+SqlTests.RefusesUnauthorized [1 ms]\n  Error Message:\n   x\n'), [], decl(B, S)), []);
  const plain = lines('public class ServiceTests', '{', '    [Fact]', '    public void Refuses() { x.Should().BeEmpty(); }', '}');
  assert.deepEqual(survivors(['Refuses'], failureReasons('  Failed Demo.ServiceTests.Refuses [1 ms]\n  Error Message:\n   x\n'), [], declaredTests(plain, 'A.cs')), []);
});

// ---- Repair round 2026-11-18, round 4 (eight more confirmed problems) ----

test('round 4 problems 1-5: a fake member, a bang member, a destructured or described shadow, a regex after an operator; a factory helper still counts', async () => {
  const { testSpans, helperCallers } = await import('../scripts/proof-record.mjs');
  const js = (body, file = 'src/rows.test.cjs') => { const t = lines('function expectNoRows(rows) {', '  expect(rows).toEqual([]);', '}', "it('refuses', () => {", ...body, '});'); return helperCallers(t, testSpans(t, file), 2).length; };
  // 1: a method written inside the test, a class method, a TS type member.
  assert.equal(js(['  const other = { expectNoRows(rows) { return rows; } };', '  other.expectNoRows(product.rows());']), 0, 'object method');
  assert.equal(js(['  class Fake { expectNoRows(rows) { return rows; } }', '  new Fake().expectNoRows(product.rows());']), 0, 'class method');
  assert.equal(js(['  const other: { expectNoRows(rows: unknown[]): void } = make();', '  other.expectNoRows(product.rows());'], 'src/rows.test.ts'), 0, 'type member');
  // 2: a bang before the dot.
  assert.equal(js(['  other!.expectNoRows(product.rows());'], 'src/rows.test.ts'), 0, 'bang member');
  assert.equal(js(["  'x'.expectNoRows(rows);"]), 0, 'member of a string');
  // 3: destructuring, later declarator, class, describe-level const.
  assert.equal(js(['  const { expectNoRows } = fakes;', '  expectNoRows(product.rows());']), 0, 'object pattern');
  assert.equal(js(['  const [expectNoRows] = fakes;', '  expectNoRows(product.rows());']), 0, 'array pattern');
  assert.equal(js(['  let a = 1, expectNoRows = noop;', '  expectNoRows(product.rows());']), 0, 'later declarator');
  assert.equal(js(['  class expectNoRows {}', '  expectNoRows(product.rows());']), 0, 'class');
  const desc = lines('function expectNoRows(rows) {', '  expect(rows).toEqual([]);', '}', "describe('d', () => {", '  const expectNoRows = () => {};', "  it('refuses', () => {", '    expectNoRows(rows);', '  });', '});');
  assert.equal(helperCallers(desc, testSpans(desc, 'src/rows.test.cjs'), 2).length, 0, 'describe-level const');
  // 4: a regex literal after an operator, a brace, or an if head with a paren in a string.
  for (const l of ["  const s = 'a' + /expectNoRows(rows)/.source;", '  if (true) {} /expectNoRows(rows)/.test(x);', '  const b = 1 < /expectNoRows(rows)/.lastIndex;', "  if (s === ')') /expectNoRows(rows)/.test(x);"]) assert.equal(js([l]), 0, l);
  // 5: a helper made inside a factory, reached through the result.
  const fac = (body) => { const t = lines('function setup() {', '  const expectNoRows = () => {', '    expect(product.rows()).toEqual([]);', '  };', '  return { expectNoRows };', '}', "it('refuses', () => {", ...body, '});'); return helperCallers(t, testSpans(t, 'src/rows.test.cjs'), 3).length; };
  assert.equal(fac(['  const ui = setup();', '  ui.expectNoRows();']), 1, 'member of the factory result');
  assert.equal(fac(['  setup().expectNoRows();']), 1, 'direct member');
  assert.equal(fac(['  const expectNoRows = setup().expectNoRows;', '  expectNoRows();']), 1, 'alias');
  assert.equal(fac(['  const { expectNoRows } = setup();', '  expectNoRows();']), 1, 'destructured');
  assert.equal(fac(['  other.expectNoRows();']), 0, 'a fake in a test that never calls the factory');
  // Must not change: plain calls, division, and an honest describe-level helper.
  assert.equal(js(['  expectNoRows(product.rows());']), 1);
  assert.equal(js(['  const total = a / expectNoRows(rows) / 2;']), 1);
  assert.equal(js(['  const ok = a > b ? expectNoRows(rows) : 0;']), 1, 'ternary call is not a member declaration');
  assert.equal(js(['  const { other } = fakes;', '  expectNoRows(product.rows());']), 1, 'an unrelated pattern');
  assert.equal(js(['  const { expectNoRows: renamed } = fakes;', '  expectNoRows(product.rows());']), 1, 'a renamed key is no binding');
  const own = lines("describe('d', () => {", '  const expectNoRows = () => {', '    expect(rows).toEqual([]);', '  };', "  it('refuses', () => {", '    expectNoRows(rows);', '  });', '});');
  assert.equal(helperCallers(own, testSpans(own, 'src/rows.test.cjs'), 3).length, 1, 'the describe-level helper itself');
});

test('round 4 problems 3, 6 (C#): any local type shadows; an extension, fixture or base member counts', async () => {
  const { testSpans, helperCallers } = await import('../scripts/proof-record.mjs');
  const cs = (body) => { const t = lines('public class RowsTests', '{', '    private static void ExpectNoRows(List<int> rows)', '    {', '        rows.Should().BeEmpty();', '    }', '', '    [Fact]', '    public void Refuses_Unauthorized()', '    {', ...body, '    }', '}'); return helperCallers(t, testSpans(t, 'Api.Tests/RowsTests.cs'), 5).length; };
  assert.equal(cs(['        bool ExpectNoRows(List<int> r) => true;', '        ExpectNoRows(rows);']), 0, 'bool local function');
  assert.equal(cs(['        string ExpectNoRows(List<int> r) { return ""; }', '        ExpectNoRows(rows);']), 0, 'string local function');
  assert.equal(cs(['        Action<List<int>> ExpectNoRows = r => { };', '        ExpectNoRows(rows);']), 0, 'nested generic delegate');
  assert.equal(cs(['        other!.ExpectNoRows(rows);']), 0, 'bang member of another object');
  assert.equal(cs(['        var x = await ExpectNoRowsAsync(rows);', '        ExpectNoRows(rows);']), 1, 'must not change: a plain call');
  assert.equal(cs(['        return ExpectNoRows(rows);']), 1, 'must not change: return keyword is no type');
  const ext = lines('public static class RowAsserts', '{', '    public static void ShouldHaveNoRows(this List<int> rows)', '    {', '        rows.Should().BeEmpty();', '    }', '}', 'public class RowsTests', '{', '    [Fact]', '    public void Refuses() { rows.ShouldHaveNoRows(); }', '}');
  assert.equal(helperCallers(ext, testSpans(ext, 'Api.Tests/RowsTests.cs'), 5).length, 1, 'extension method');
  const fix = lines('public class DbFixture', '{', '    public void ExpectNoRows(List<int> rows)', '    {', '        rows.Should().BeEmpty();', '    }', '}', 'public class RowsTests', '{', '    [Fact]', '    public void Refuses() { _db.ExpectNoRows(rows); }', '}');
  assert.equal(helperCallers(fix, testSpans(fix, 'Api.Tests/RowsTests.cs'), 5).length, 1, 'fixture member');
  const bas = lines('public abstract class RowsBase', '{', '    protected void ExpectNoRows(List<int> rows)', '    {', '        rows.Should().BeEmpty();', '    }', '}', 'public class RowsTests : RowsBase', '{', '    [Fact]', '    public void Refuses() { base.ExpectNoRows(rows); }', '}');
  assert.equal(helperCallers(bas, testSpans(bas, 'Api.Tests/RowsTests.cs'), 5).length, 1, 'base member');
});

test('round 4 problems 7, 8 (C#): a failure with no class does not credit an inherited test without a derived class; nested brackets in a base call', async () => {
  const { survivors, caughtTests, failureReasons } = await import('../scripts/red-proof.mjs');
  const { testSpans, declaredTests } = await import('../scripts/proof-record.mjs');
  const abs = lines('namespace Demo;', 'public abstract class BaseTests', '{', '    [Fact(DisplayName = "refuses unauthorized")]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '}');
  const none = failureReasons('  Failed refuses unauthorized [12 ms]\n  Error Message:\n   Assert.True() Failure\n');
  const left = survivors(['RefusesUnauthorized'], none, [], declaredTests(abs, 'Api.Tests/BaseTests.cs'));
  assert.equal(left.length, 1);
  assert.match(left[0], /cannot be matched/);
  assert.deepEqual(caughtTests(['RefusesUnauthorized'], none, [], testSpans(abs, 'Api.Tests/BaseTests.cs')), []);
  // Must not change: a plain class is still credited by a failure that prints no class.
  const plain = lines('public class ServiceTests', '{', '    [Fact(DisplayName = "refuses it")]', '    public void Refuses() { x.Should().BeEmpty(); }', '}');
  assert.deepEqual(survivors(['Refuses'], failureReasons('  Failed refuses it [1 ms]\n  Error Message:\n   x\n'), [], declaredTests(plain, 'A.cs')), []);
  // 8: a derived class whose base call holds nested brackets.
  const base = lines('namespace Demo;', 'public abstract class BaseTests', '{', '    [Fact]', '    public void RefusesUnauthorized() { x.Should().BeEmpty(); }', '}');
  const sql = lines('namespace Demo;', 'public class SqlTests(Db db) : BaseTests(db, new Options())', '{', '    [Fact]', '    public void Own() { }', '}');
  const decl = [...declaredTests(base, 'Api.Tests/BaseTests.cs'), ...declaredTests(sql, 'Api.Tests/SqlTests.cs')];
  const fail = failureReasons('  Failed Demo.SqlTests.RefusesUnauthorized [12 ms]\n  Error Message:\n   x\n');
  assert.deepEqual(survivors(['RefusesUnauthorized'], fail, [], decl), []);
  assert.equal(caughtTests(['RefusesUnauthorized'], fail, [], [...testSpans(base, 'Api.Tests/BaseTests.cs'), ...testSpans(sql, 'Api.Tests/SqlTests.cs')]).length, 1);
});
