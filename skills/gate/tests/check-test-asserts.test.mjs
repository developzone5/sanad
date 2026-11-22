import './neutral-git-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addedLines, rangeAsserts, nothingChecks, untagged, nonNullReads, newTests, hasEvidence, taggedTests, checkLinesWithoutEvidence } from '../scripts/check-test-asserts.mjs';

test('a value read inside an assertion with ! is found; ?. and plain reads are not', () => {
  const lines = ["expect(document.getElementById('hint')!.textContent).toBe('x');", "expect(document.getElementById('hint')?.textContent).toBe('x');",
    'expect(rows[0]!.name).toBe(1);', 'const el = screen.getByRole("group")!;'].map((text, i) => ({ file: 'src/a.test.tsx', line: i + 1, text }));
  assert.deepEqual(nonNullReads(lines).map(l => l.line), [1, 3]);
});
import { writeEntry, testFileHashes, provenTestFiles, skippedLines, codeFingerprint, testSpans, writeBreakResult, writeRunFacts } from '../scripts/proof-record.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-test-asserts.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-asserts-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// A proof entry as red-proof.mjs writes it since 2026-11-17 (audit: one caught test certified another rule's
// vacuous check, and a proof outlived an edit to other code): it names the tests its breaks made fail (`caught`,
// by test file: line and title) and holds the id of the code as it is now (`code`). The two command tests below
// wrote entries with test files and targets only, which pinned the old reading: such an entry proves nothing now.
const proofOf = (repo, breaks, caught, targets) => ({ ok: true, breaks, files: testFileHashes(repo, Object.keys(caught)), targets, caught, code: codeFingerprint(repo) });

test('"nothing happens" checks are found in test files, in each stack\'s words', () => {
  const lines = ['expect(api.create).not.toHaveBeenCalled();', 'expect(screen.queryByRole("dialog")).toBeNull();', 'expect(count()).toBe(0);',
    'mock.Verify(x => x.Save(), Times.Never);', 'Assert.Empty(rows);', 'expect(count()).toBe(1);'].map((text, i) => ({ file: i === 3 || i === 4 ? 'Api.Tests/SaveTests.cs' : 'src/a.test.tsx', line: i + 1, text }));
  assert.deepEqual(nothingChecks(lines).map(l => l.line), [1, 2, 3, 4, 5]);
  assert.deepEqual(nothingChecks([{ file: 'src/a.tsx', line: 1, text: 'x.toBeNull()' }]), [], 'product code is not a test');
});

test('check line tags: each Cn needs a new test line tagged [Cn]; a list tag counts for each', () => {
  const lines = [{ file: 'src/a.test.tsx', line: 1, text: "it('[C1] once after save', () => {" }, { file: 'src/a.test.tsx', line: 2, text: '// [C2, C4] twice and in Arabic' },
    { file: 'src/a.tsx', line: 3, text: '// [C3] in product code does not count' }];
  assert.deepEqual(untagged(4, lines), [3]);
});

test('the command: an unproven "nothing happens" check fails until a break run proves the test files as they are now', () => {
  const repo = fs.mkdtempSync(path.join(root, 'proof-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/form.test.ts'), "it('[C1] saves nothing', () => { expect(api.create).not.toHaveBeenCalled(); });\n");
  const check = path.join(root, 'check.md'); fs.writeFileSync(check, '- saves nothing\n');
  const run = () => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main', '--check', check], { encoding: 'utf8', windowsHide: true, env: process.env });
  const targets = () => testFileHashes(repo, ['a.txt']);
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNPROVEN: src\/form\.test\.ts:1/);
  // 2026-11-17: the entries name the caught tests and hold the code id (proofOf above); a list of files alone
  // was enough before.
  const first = { line: 1, title: '[C1] saves nothing' }, second = { line: 2, title: '[C1] again' };
  writeEntry(repo, 'page', proofOf(repo, 1, { 'src/form.test.ts': [first] }, targets()));
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 "nothing happens" check\(s\) proven by a break run\)/);
  fs.appendFileSync(path.join(repo, 'src/form.test.ts'), "it('[C1] again', () => { expect(x).toBeNull(); });\n");
  assert.equal(run().status, 1, 'a test edit after the proof needs a new proof run');
  writeEntry(repo, 'page', proofOf(repo, 0, { 'src/form.test.ts': [first, second] }, targets()));
  assert.equal(run().status, 1, 'an old-code run alone is not a break proof');
  fs.writeFileSync(check, '- saves nothing\n- shows once\n');
  writeEntry(repo, 'page', proofOf(repo, 1, { 'src/form.test.ts': [first, second] }, targets()));
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNTAGGED: check line C2 has no new test tagged \[C2\]/);
  assert.doesNotMatch(r.stdout, /UNPROVEN/, 'both tests are named in the entry');
});

// 2026-11-13: run before the proof, the check skips only the proof part: tags, ranges and non-null reads
// are still judged, so a label fixed now does not void a proof already run.
test('the command with --before-proof: an unproven "nothing happens" check passes; an untagged check line still fails', () => {
  const repo = fs.mkdtempSync(path.join(root, 'before-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/form.test.ts'), "it('[C1] saves nothing', () => { expect(api.create).not.toHaveBeenCalled(); });\n");
  const check = path.join(repo, '..', 'before-check.md'); fs.writeFileSync(check, '- saves nothing\n');
  const run = (...extra) => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main', '--check', check, ...extra], { encoding: 'utf8', windowsHide: true, env: process.env });
  assert.equal(run().status, 1, 'without the flag the proof part still fails');
  let r = run('--before-proof');
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /UNPROVEN/);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 "nothing happens" check\(s\): proof judged after the proof run\)/);
  fs.writeFileSync(check, '- saves nothing\n- shows once\n');
  r = run('--before-proof');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNTAGGED: check line C2 has no new test tagged \[C2\]/);
});

// 2026-11-12 (S4/C5/S8): one record cleared every "nothing happens" check of both stacks; a frontend
// proof cleared backend checks, and a product change after the proof kept clearing them.
// 2026-11-17 (audit: a stale proof survived an edit to a dependency): this test said that a change to rule.ts
// voids only the page entry, whose break changed that file, and that the server entry stays. That was the gap:
// the server tests may depend on rule.ts too. Any code edit voids every entry now; a changed break target still
// voids its own entry, shown with entries proved again on the new code.
test('the command: a check counts as proven only when its own test is in a current entry; a code edit voids every entry, a changed break target its own', () => {
  const repo = fs.mkdtempSync(path.join(root, 'stacks-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'rule.ts'), 'export const blocks = true;\n'); fs.writeFileSync(path.join(repo, 'Rule.cs'), 'class Rule {}\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'Api.Tests'));
  fs.writeFileSync(path.join(repo, 'src/form.test.ts'), "it('saves nothing', () => { expect(api.create).not.toHaveBeenCalled(); });\n");
  fs.writeFileSync(path.join(repo, 'Api.Tests/RuleTests.cs'), '[Fact] public void Refuses() { rows.Should().BeEmpty(); }\n');
  const run = () => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main'], { encoding: 'utf8', windowsHide: true, env: process.env });
  const page = () => proofOf(repo, 1, { 'src/form.test.ts': [{ line: 1, title: 'saves nothing' }] }, testFileHashes(repo, ['rule.ts']));
  const server = () => proofOf(repo, 1, { 'Api.Tests/RuleTests.cs': [{ line: 1, title: 'Refuses' }] }, testFileHashes(repo, ['Rule.cs']));
  const proved = page();
  writeEntry(repo, 'page', proved);
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNPROVEN: Api\.Tests\/RuleTests\.cs:1/, 'a frontend proof does not prove a backend check');
  assert.doesNotMatch(r.stdout, /UNPROVEN: src\/form/);
  writeEntry(repo, 'server', server());
  r = run();
  assert.equal(r.status, 0, 'a second proof adds its entry; the first stays: ' + r.stdout);
  assert.deepEqual([...provenTestFiles(repo)].sort(), ['Api.Tests/RuleTests.cs', 'src/form.test.ts']);
  fs.writeFileSync(path.join(repo, 'rule.ts'), 'export const blocks = true; // reviewed\n');
  r = run();
  assert.equal(r.status, 1, 'the code changed after both proofs');
  assert.match(r.stdout, /UNPROVEN: src\/form\.test\.ts:1/);
  assert.match(r.stdout, /UNPROVEN: Api\.Tests\/RuleTests\.cs:1/, 'the server proof is of the code before the edit too');
  // Both proved again on the new code, the page entry with rule.ts as its break found it before the edit.
  writeEntry(repo, 'server', server());
  writeEntry(repo, 'page', { ...page(), targets: proved.targets });
  r = run();
  assert.equal(r.status, 1, 'the page proof broke rule.ts as it was; it changed since');
  assert.match(r.stdout, /UNPROVEN: src\/form\.test\.ts:1/);
  assert.doesNotMatch(r.stdout, /UNPROVEN: Api\.Tests/);
});

// 2026-11-12 (C12): backend tests assert with FluentAssertions; its range and "nothing happens" forms were missed.
test('FluentAssertions range and "nothing happens" forms are found; // range: <why> still excuses a range', () => {
  const cs = (text, i) => ({ file: 'Api.Tests/RuleTests.cs', line: i + 1, text });
  const ranges = ['count.Should().BeGreaterThan(0);', 'count.Should().BeGreaterThanOrEqualTo(1);', 'count.Should().BeLessThan(3);',
    'count.Should().BeLessThanOrEqualTo(1);', 'count.Should().BeInRange(1, 3);', 'ms.Should().BeLessThan(5000); // range: a time limit, never exact',
    'count.Should().Be(1);'].map(cs);
  assert.deepEqual(rangeAsserts(ranges).map(l => l.line), [1, 2, 3, 4, 5]);
  const nothing = ['count.Should().Be(0);', 'rows.Should().HaveCount(0);', 'rows.Should().BeEmpty();', 'row.Should().BeNull();', 'saved.Should().BeFalse();',
    'names.Should().NotContain("x");', 'count.Should().Be(10);', 'rows.Should().HaveCount(2);', 'saved.Should().BeTrue();'].map(cs);
  assert.deepEqual(nothingChecks(nothing).map(l => l.line), [1, 2, 3, 4, 5, 6]);
});

// 2026-11-12 (C10): a [Cn] tag on a skipped test counted as a tested check line, though the test never runs.
test('a [Cn] tag on a skipped or todo test does not count; one on a running test does', () => {
  const js = [
    "it.skip('[C1] saves nothing', () => {",
    '  expect(1).toBe(1);',
    '});',
    "it.todo('[C2] later');",
    "describe.skip('group', () => {",
    "  it('[C3] inside a skipped group', () => {});",
    '});',
    "xit('[C4] old style', () => {});",
    '// [C5] quoted above a skipped test',
    "test.skip('five', () => {});",
    "it('[C6] runs', () => {});",
  ].join('\n');
  const jsLines = js.split('\n').map((text, i) => ({ file: 'src/a.test.tsx', line: i + 1, text }));
  const skipJs = skippedLines(js, 'src/a.test.tsx');
  assert.deepEqual(untagged(6, jsLines, l => skipJs.has(l.line)), [1, 2, 3, 4, 5]);
  const cs = [
    'public class RuleTests {',
    '  // [C1] a comment above a skipped fact',
    '  [Fact(DisplayName = "[C2] refuses", Skip = "flaky")]',
    '  public void Refuses() { Assert.True(false); }',
    '  [Theory(Skip = "later")]',
    '  [InlineData(1)]',
    '  public void Later(int n) { /* [C3] */ }',
    '  [Fact(DisplayName = "[C4] runs")]',
    '  public void Runs() { }',
    '}',
  ].join('\n');
  const csLines = cs.split('\n').map((text, i) => ({ file: 'Api.Tests/RuleTests.cs', line: i + 1, text }));
  const skipCs = skippedLines(cs, 'Api.Tests/RuleTests.cs');
  assert.deepEqual(untagged(4, csLines, l => skipCs.has(l.line)), [1, 2, 3]);
  assert.deepEqual(untagged(4, csLines), [], 'without the skip test every tag counts, as before');
});

test('the command: a check line tagged only on a skipped test is UNTAGGED', () => {
  const repo = fs.mkdtempSync(path.join(root, 'skip-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/form.test.ts'), "it('[C1] shows once', () => { expect(n).toBe(1); });\nit.skip('[C2] saves later', () => { expect(n).toBe(2); });\n");
  const check = path.join(root, 'check-skip.md'); fs.writeFileSync(check, '- shows once\n- saves later\n');
  const r = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main', '--check', check], { encoding: 'utf8', windowsHide: true, env: process.env });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNTAGGED: check line C2 has no new test tagged \[C2\]/);
  assert.doesNotMatch(r.stdout, /UNTAGGED: check line C1/);
});

test('added diff lines keep their file and new line number', () => {
  const diff = ['diff --git a/src/a.test.ts b/src/a.test.ts', '--- a/src/a.test.ts', '+++ b/src/a.test.ts', '@@ -10,0 +11,2 @@', '+one', '+two', '@@ -20 +22 @@', '-old', '+three'].join('\n');
  assert.deepEqual(addedLines(diff), [{ file: 'src/a.test.ts', line: 11, text: 'one' }, { file: 'src/a.test.ts', line: 12, text: 'two' }, { file: 'src/a.test.ts', line: 22, text: 'three' }]);
});

test('a range matcher in a test file is found; exact asserts, product code and a stated reason are not', () => {
  const lines = [
    { file: 'src/a.test.tsx', line: 1, text: '    expect(count()).toBeLessThanOrEqual(1);' },
    { file: 'src/a.test.tsx', line: 2, text: '    expect(n).toBeGreaterThan(0);' },
    { file: 'Api.Tests/FooTests.cs', line: 3, text: '        Assert.InRange(total, 1, 3);' },
    { file: 'src/a.test.tsx', line: 4, text: '    expect(count()).toBe(1);' },
    { file: 'src/a.ts', line: 5, text: '    if (x.toBeLessThan(1)) {}' },
    { file: 'src/a.test.tsx', line: 6, text: '    expect(ms).toBeLessThan(5000); // range: a time limit, never exact' },
  ];
  assert.deepEqual(rangeAsserts(lines).map(l => l.line), [1, 2, 3]);
});

test('the command reads the change against its base, untracked test files included', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/old.test.ts'), 'expect(a).toBeLessThan(2);\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const run = () => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main'], { encoding: 'utf8', windowsHide: true });
  let r = run();
  assert.equal(r.status, 0, 'a range assert already on the base is not new');
  assert.match(r.stdout, /TEST ASSERTS: none/);
  fs.appendFileSync(path.join(repo, 'src/old.test.ts'), 'expect(b).toBeGreaterThanOrEqual(1);\n');
  fs.writeFileSync(path.join(repo, 'src/new.test.ts'), 'expect(c).toBe(1);\nexpect(d).toBeLessThanOrEqual(1);\n');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /RANGE ASSERT: src\/old\.test\.ts:2 — expect\(b\)\.toBeGreaterThanOrEqual\(1\);/);
  assert.match(r.stdout, /RANGE ASSERT: src\/new\.test\.ts:2 — expect\(d\)\.toBeLessThanOrEqual\(1\);/);
  assert.match(r.stdout, /TEST ASSERTS: 2 range, 0 unproven, 0 untagged, 0 non-null/);
  assert.equal(spawnSync(process.execPath, [script, '--repo', root], { encoding: 'utf8', windowsHide: true }).status, 2, 'not a repository');
});

// ---- 2026-11-19: evidence for every new test and every check line ----
// On day 3 check line 16 went to review with a tagged test that no run had ever seen fail: only "nothing happens"
// lines were asked for a proof. Every new test now needs evidence on the code as it is now.

// A small repository with one commit on main; `files` are its base files.
function freshRepo(prefix, files = { 'a.txt': 'x\n', 'b.txt': 'y\n' }) {
  const repo = fs.mkdtempSync(path.join(root, prefix));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  for (const [f, t] of Object.entries(files)) write(f, t);
  git('add', '-A'); git('commit', '-qm', 'base');
  // 2026-11-20 (V5): the evidence rows fail by default. `loose` runs with the default; `run` forces strict;
  // `soft` runs after `git config sanad.strictEvidence false` (the owner's way to step back).
  const loose = (...extra) => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main', ...extra], { encoding: 'utf8', windowsHide: true, env: process.env });
  const run = (...extra) => loose('--strict-evidence', ...extra);
  const soft = (...extra) => { git('config', 'sanad.strictEvidence', 'false'); return loose(...extra); };
  return { repo, git, write, run, loose, soft };
}

test('the command: a new test that no break names and no run saw fail on the old code is NOT PROVEN TEST, by name', () => {
  const { repo, write, run } = freshRepo('new-test-');
  // No "nothing happens" line here: before 2026-11-19 this change passed with no proof at all.
  write('src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });\n");
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^NOT PROVEN TEST: src\/form\.test\.ts:1 shows the count once$/m);
  assert.match(r.stdout, /TEST ASSERTS: 0 range, 0 unproven, 0 untagged, 0 non-null, 1 not proven test\(s\), 0 no evidence/);
  assert.match(r.stdout, /it failed on the old code \(red-proof\.mjs --old[^\n]*a caught break names it \(red-proof\.mjs --breaks/, 'the two ways to give it evidence');
  writeEntry(repo, 'page', proofOf(repo, 1, { 'src/form.test.ts': [{ line: 1, title: 'shows the count once' }] }, testFileHashes(repo, ['a.txt'])));
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 new test\(s\) with evidence\)/);
  // An edit of a file that is no test and no break target: the proof is of other code, so the test is not proven.
  write('b.txt', 'y, reviewed\n');
  r = run();
  assert.equal(r.status, 1, 'the code changed after the proof: ' + r.stdout);
  assert.match(r.stdout, /^NOT PROVEN TEST: src\/form\.test\.ts:1 shows the count once$/m);
  assert.match(r.stdout, /the code changed after a proof ran/, 'the reason is said');
  // --before-proof leaves the evidence to the run after the proof, and says so.
  r = run('--before-proof');
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /NOT PROVEN TEST/);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 new test\(s\): evidence judged after the proof run\)/);
});

test('the command: a test seen failing on the old code has evidence; its "nothing happens" line still needs a caught break', () => {
  const { repo, write, run } = freshRepo('old-code-');
  write('src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });\nit('saves nothing', () => { expect(api.create).not.toHaveBeenCalled(); });\n");
  const seen = [{ file: 'src/form.test.ts', line: 1, title: 'shows the count once' }, { file: 'src/form.test.ts', line: 2, title: 'saves nothing' }];
  // The old-code run saw both fail, but the passing run did not pass on this tree: nothing counts.
  writeRunFacts(repo, 'page', { tree: codeFingerprint(repo), run: 'r1', green: false, redOld: seen });
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /NOT PROVEN TEST: src\/form\.test\.ts:1 shows the count once/);
  writeRunFacts(repo, 'page', { tree: codeFingerprint(repo), run: 'r2', green: true, redOld: seen });
  r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /NOT PROVEN TEST/, 'both tests were seen failing on the old code');
  assert.match(r.stdout, /UNPROVEN: src\/form\.test\.ts:2/, 'the old code never proves a "nothing happens" line');
  // A break that names the test, saved as its own result on this tree.
  writeBreakResult(repo, 'page', { name: 'always save', file: 'a.txt', find: 'x', put: 'z', mustFail: ['saves nothing'] },
    { state: 'caught', tree: codeFingerprint(repo), run: 'r2', caught: [seen[1]] });
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 "nothing happens" check\(s\) proven by a break run\) \(2 new test\(s\) with evidence\)/);
});

test('the command: a server proof gives a page test no evidence, and the reverse', () => {
  const { repo, write, run } = freshRepo('sides-', { 'rule.ts': 'export const blocks = true;\n', 'Rule.cs': 'class Rule {}\n' });
  write('src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });\n");
  write('Api.Tests/RuleTests.cs', '[Fact] public void Accepts() { count.Should().Be(1); }\n');
  const page = () => proofOf(repo, 1, { 'src/form.test.ts': [{ line: 1, title: 'shows the count once' }] }, testFileHashes(repo, ['rule.ts']));
  const server = () => proofOf(repo, 1, { 'Api.Tests/RuleTests.cs': [{ line: 1, title: 'Accepts' }] }, testFileHashes(repo, ['Rule.cs']));
  writeEntry(repo, 'page', page());
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /NOT PROVEN TEST: Api\.Tests\/RuleTests\.cs:1 Accepts/);
  assert.doesNotMatch(r.stdout, /NOT PROVEN TEST: src\/form/);
  writeEntry(repo, 'page', { ok: false, reason: 'not caught' });
  writeEntry(repo, 'server', server());
  r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /NOT PROVEN TEST: src\/form\.test\.ts:1 shows the count once/);
  assert.doesNotMatch(r.stdout, /NOT PROVEN TEST: Api\.Tests/);
  writeEntry(repo, 'page', page());
  assert.equal(run().status, 0, 'each side proved by its own proof');
});

test('evidence rows are read strictly: the same file, line and title, "old code" or "break <name>" only, never a skipped test', () => {
  const rows = [{ file: 'src/a.test.ts', line: 1, title: 'one', evidence: 'old code' }, { file: 'src/a.test.ts', line: 2, title: 'two', evidence: 'break drop the guard' },
    { file: 'src/a.test.ts', line: 3, title: 'three', evidence: 'none' }, { file: 'src/a.test.ts', line: 4, title: 'four', evidence: 'yes' }, { file: 'src/a.test.ts', line: 5, title: 'five', evidence: 'break ' }];
  const t = (line, title, more = {}) => ({ file: 'src/a.test.ts', line, titles: [title], ...more });
  assert.equal(hasEvidence(rows, t(1, 'one')), true);
  assert.equal(hasEvidence(rows, t(2, 'two')), true);
  assert.equal(hasEvidence(rows, t(3, 'three')), false, 'none');
  assert.equal(hasEvidence(rows, t(4, 'four')), false, 'a word that is no evidence');
  assert.equal(hasEvidence(rows, t(5, 'five')), false, 'a break with no name');
  assert.equal(hasEvidence(rows, t(1, 'one, renamed')), false, 'a title changed after the proof');
  assert.equal(hasEvidence(rows, t(9, 'one')), false, 'another test with the same title, on another line');
  assert.equal(hasEvidence(rows, { ...t(1, 'one'), file: 'Api.Tests/ATests.cs' }), false, 'another test file');
  assert.equal(hasEvidence(rows, t(1, 'one', { skipped: true })), false, 'a skipped test never runs');
  assert.equal(hasEvidence(null, t(1, 'one')), false, 'no answer from the record');
});

test('a tag belongs to the test that holds it or the test right below its comment; a tag on a describe block is on no test', () => {
  const js = [
    "describe('[C1] the form', () => {",
    '  // [C2] quoted above the test below',
    "  it('saves once', () => { expect(n).toBe(1); });",
    "  it('[C3] shows it', () => {",
    '    expect(m).toBe(2); // [C6] inside the test',
    '  });',
    '  // [C4] a comment with a blank line under it',
    '',
    "  it('other', () => {});",
    "  it.skip('[C5] later', () => {});",
    '});',
  ].join('\n');
  const file = 'src/a.test.tsx';
  const lines = js.split('\n').map((text, i) => ({ file, line: i + 1, text }));
  const tagged = taggedTests(lines, () => ({ rows: js.split('\n'), spans: testSpans(js, file) }));
  const of = (n) => ({ tests: tagged.get(n).tests.map(s => s.line), loose: tagged.get(n).loose.map(l => l.line) });
  assert.deepEqual(of(1), { tests: [], loose: [1] }, 'a describe title');
  assert.deepEqual(of(2), { tests: [3], loose: [] }, 'the test right below the comment, not another one');
  assert.deepEqual(of(3), { tests: [4], loose: [] });
  assert.deepEqual(of(6), { tests: [4], loose: [] }, 'a comment inside the test');
  assert.deepEqual(of(4), { tests: [], loose: [7] }, 'a blank line under the comment');
  assert.deepEqual(of(5), { tests: [10], loose: [] });
  // Only the test at line 3 has evidence: C2 passes; every other tagged check line is listed with its reason.
  const left = checkLinesWithoutEvidence(7, tagged, (s) => s.line === 3);
  assert.deepEqual(left.map(c => c.n), [1, 3, 4, 5, 6], 'C7 has no tag at all: UNTAGGED says it');
  assert.match(left[0].why, /the tag at src\/a\.test\.tsx:1 is on no test/);
  assert.match(left[1].why, /^src\/a\.test\.tsx:4 "\[C3\] shows it": no run has seen it fail/);
  assert.match(left[3].why, /^src\/a\.test\.tsx:10 "\[C5\] later" is skipped: it never runs$/);
  // C#: the comment and attribute lines above a [Fact] belong to it; a tag above the class is on no test.
  const cs = ['// [C1] above the class', 'public class RuleTests {', '  // [C2] above the attributes', '  [Trait("a", "b")]', '  [Fact(DisplayName = "[C3] refuses")]',
    '  public void Refuses() { Assert.True(false); }', '}'].join('\n');
  const csFile = 'Api.Tests/RuleTests.cs';
  const csTagged = taggedTests(cs.split('\n').map((text, i) => ({ file: csFile, line: i + 1, text })), () => ({ rows: cs.split('\n'), spans: testSpans(cs, csFile) }));
  assert.deepEqual([1, 2, 3].map(n => [csTagged.get(n).tests.map(s => s.titles[0]), csTagged.get(n).loose.length]), [[[], 1], [['Refuses'], 0], [['Refuses'], 0]]);
});

test('the command: a check line needs a tagged test with evidence; a skipped one, a test no run saw fail and a describe tag are NO EVIDENCE', () => {
  const { repo, write, run } = freshRepo('tags-');
  write('src/form.test.ts', [
    '// [C1] the count',
    "it('shows the count once', () => { expect(n).toBe(1); });",
    "it('[C2] shows the name', () => { expect(name).toBe('a'); });",
    "describe('[C3] group', () => {",
    "  it('inside', () => { expect(x).toBe(2); });",
    '});',
    "it.skip('[C4] saves later', () => { expect(n).toBe(2); });",
    '',
  ].join('\n'));
  const check = path.join(root, 'check-tags.md'); fs.writeFileSync(check, '- the count\n- the name\n- the group\n- saves later\n');
  const first = { line: 2, title: 'shows the count once' }, inside = { line: 5, title: 'inside' }, name = { line: 3, title: '[C2] shows the name' };
  writeEntry(repo, 'page', proofOf(repo, 1, { 'src/form.test.ts': [first, inside] }, testFileHashes(repo, ['a.txt'])));
  let r = run('--check', check);
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /NO EVIDENCE: C1 /, 'the comment tag belongs to the proven test below it');
  assert.match(r.stdout, /^NO EVIDENCE: C2 — src\/form\.test\.ts:3 "\[C2\] shows the name": no run has seen it fail on the code as it is now$/m);
  assert.match(r.stdout, /^NOT PROVEN TEST: src\/form\.test\.ts:3 \[C2\] shows the name$/m);
  assert.match(r.stdout, /^NO EVIDENCE: C3 — the tag at src\/form\.test\.ts:4 is on no test/m, 'a proven test inside the group does not carry the tag of the group');
  assert.match(r.stdout, /^UNTAGGED: check line C4 has no new test tagged \[C4\]$/m, 'as before');
  assert.match(r.stdout, /^NO EVIDENCE: C4 — src\/form\.test\.ts:7 "\[C4\] saves later" is skipped: it never runs$/m);
  assert.match(r.stdout, /TEST ASSERTS: 0 range, 0 unproven, 1 untagged, 0 non-null, 1 not proven test\(s\), 3 no evidence/);
  // Before the proof a running test's evidence is not judged. What no proof can change is said now: the tag on
  // no test and the tag on a skipped test.
  r = run('--check', check, '--before-proof');
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /NO EVIDENCE: C[12] |NOT PROVEN TEST/);
  assert.match(r.stdout, /^NO EVIDENCE: C3 — the tag at src\/form\.test\.ts:4 is on no test/m);
  assert.match(r.stdout, /^NO EVIDENCE: C4 — src\/form\.test\.ts:7 "\[C4\] saves later" is skipped/m);
  assert.match(r.stdout, /UNTAGGED: check line C4/);
  // With every running tagged test proven, only the describe tag and the skipped test are left.
  writeEntry(repo, 'page', proofOf(repo, 1, { 'src/form.test.ts': [first, inside, name] }, testFileHashes(repo, ['a.txt'])));
  r = run('--check', check);
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /NO EVIDENCE: C[12] |NOT PROVEN TEST/);
  assert.match(r.stdout, /NO EVIDENCE: C3 /);
});

test('new tests: a renamed file, a changed older test and a helper-only file ask for no evidence; a changed title does', () => {
  // The moved file holds three tests, so git still reads it as renamed after one more is added (it compares the
  // texts: a small file that doubles in size reads as a new file, and all its tests as new).
  const moved = "it('shows once', () => { expect(n).toBe(1); });\nit('shows the name', () => { expect(name).toBe('a'); });\nit('shows the date', () => { expect(day).toBe(3); });\n";
  const { repo, git, write, run } = freshRepo('older-', {
    'a.txt': 'x\n',
    'src/old.test.ts': moved,
    'src/keep.test.ts': "it('keeps the name', () => { expect(name).toBe('a'); });\nit('keeps the count', () => { expect(n).toBe(1); });\n",
  });
  git('mv', 'src/old.test.ts', 'src/moved.test.ts');
  // An older test whose body changed: it passes on the old code for a good reason.
  write('src/keep.test.ts', "it('keeps the name', () => { expect(name).toBe('b'); });\nit('keeps the count', () => { expect(n).toBe(1); });\n");
  // A changed test file that declares no test.
  write('src/tests/render.ts', 'export const render = () => 1;\n');
  assert.deepEqual(newTests(repo, 'main'), []);
  let r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^TEST ASSERTS: none$/m);
  // A title changed and nothing else: it is a new test, and a proof that names the old title gives it nothing.
  write('src/keep.test.ts', "it('keeps the name', () => { expect(name).toBe('b'); });\nit('keeps the count, always', () => { expect(n).toBe(1); });\n");
  write('src/moved.test.ts', moved + "it('shows twice', () => { expect(n).toBe(2); });\n");
  assert.deepEqual(newTests(repo, 'main').map(t => `${t.file}:${t.line} ${t.titles[0]}`), ['src/keep.test.ts:2 keeps the count, always', 'src/moved.test.ts:4 shows twice']);
  writeEntry(repo, 'page', proofOf(repo, 1, { 'src/keep.test.ts': [{ line: 2, title: 'keeps the count' }], 'src/moved.test.ts': [{ line: 4, title: 'shows twice' }] }, testFileHashes(repo, ['a.txt'])));
  r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^NOT PROVEN TEST: src\/keep\.test\.ts:2 keeps the count, always$/m);
  assert.doesNotMatch(r.stdout, /NOT PROVEN TEST: src\/moved/, 'the added test of the renamed file is proven; its older test is not asked');
});

test('the command: the evidence rows fail by default; sanad.strictEvidence false makes them warnings', () => {
  const { write, git, loose } = freshRepo('loose-');
  write('src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });" + '\n');
  let r = loose();
  assert.equal(r.status, 1, 'the default: ' + r.stdout);
  assert.match(r.stdout, /^NOT PROVEN TEST: src\/form\.test\.ts:1 shows the count once$/m);
  assert.doesNotMatch(r.stdout, /are warnings only because/);
  git('config', 'sanad.strictEvidence', 'false');
  r = loose();
  assert.equal(r.status, 0, 'the owner steps back: ' + r.stdout);
  assert.match(r.stdout, /^NOT PROVEN TEST: src\/form\.test\.ts:1 shows the count once$/m, 'the row is still printed');
  assert.match(r.stdout, /are warnings only because `git config sanad\.strictEvidence false`/);
  r = loose('--strict-evidence');
  assert.equal(r.status, 1, 'the flag forces it: ' + r.stdout);
  git('config', 'sanad.strictEvidence', 'true');
  r = loose();
  assert.equal(r.status, 1, 'the config true: ' + r.stdout);
  write('src/range.test.ts', 'expect(n).toBeLessThan(5);' + '\n');
  git('config', 'sanad.strictEvidence', 'false');
  r = loose();
  assert.equal(r.status, 1, 'an older row (a range assert) fails even when stepped back: ' + r.stdout);
});

test('the command: --tests-only-lane skips the new-test evidence with one line that says why', () => {
  const { write, git, loose } = freshRepo('lane-');
  git('config', 'sanad.testsOnlyLane', 'true');
  write('src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });" + '\n');
  const r = loose('--strict-evidence', '--tests-only-lane');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^EVIDENCE SKIPPED: .*tests only.*sanad\.testsOnlyLane/m);
  assert.doesNotMatch(r.stdout, /NOT PROVEN TEST/);
});

test('Y2: a tag on no test or on a skipped test fails the check even without --strict-evidence', () => {
  const { write, loose } = freshRepo('hard-');
  write('src/form.test.ts', ["it.skip('[C1] saves later', () => { expect(n).toBe(2); });", ''].join('\n'));
  const check = path.join(root, 'check-hard.md'); fs.writeFileSync(check, '- saves later\n');
  let r = loose('--check', check);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^NO EVIDENCE: C1 — .*is skipped/m);
  write('src/form.test.ts', ["describe('[C1] group', () => {", "  it('inside', () => { expect(x).toBe(2); });", '});', ''].join('\n'));
  r = loose('--check', check);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^NO EVIDENCE: C1 — the tag at .* is on no test/m);
});

test('Y2: missing run evidence on a running tagged test fails by default and is a warning with strictEvidence false', () => {
  const { write, loose, soft } = freshRepo('soft-');
  write('src/form.test.ts', "it('[C1] shows it', () => { expect(n).toBe(1); });\n");
  const check = path.join(root, 'check-soft.md'); fs.writeFileSync(check, '- shows it\n');
  let r = loose('--check', check);
  assert.equal(r.status, 1, 'the default: ' + r.stdout);
  r = soft('--check', check);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^NO EVIDENCE: C1 /m);
});

test('Y2: the bare --tests-only-lane flag skips nothing; the switch and a tests-only change do', () => {
  const { write, git, loose } = freshRepo('lane2-');
  write('src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });\n");
  let r = loose('--strict-evidence', '--tests-only-lane');
  assert.equal(r.status, 1, 'flag alone, switch off: ' + r.stdout);
  assert.match(r.stdout, /NOT PROVEN TEST/);
  git('config', 'sanad.testsOnlyLane', 'true');
  write('a.txt', 'x, changed product code\n');
  r = loose('--strict-evidence', '--tests-only-lane');
  assert.equal(r.status, 1, 'switch on but product code changed: ' + r.stdout);
  assert.doesNotMatch(r.stdout, /EVIDENCE SKIPPED/);
  git('checkout', '--', 'a.txt');
  r = loose('--strict-evidence');
  assert.equal(r.status, 0, 'switch on, tests only, even without the flag: ' + r.stdout);
  assert.match(r.stdout, /^EVIDENCE SKIPPED:/m);
});
