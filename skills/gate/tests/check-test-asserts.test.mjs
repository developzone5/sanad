import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addedLines, rangeAsserts, nothingChecks, untagged, nonNullReads } from '../scripts/check-test-asserts.mjs';

test('a value read inside an assertion with ! is found; ?. and plain reads are not', () => {
  const lines = ["expect(document.getElementById('hint')!.textContent).toBe('x');", "expect(document.getElementById('hint')?.textContent).toBe('x');",
    'expect(rows[0]!.name).toBe(1);', 'const el = screen.getByRole("group")!;'].map((text, i) => ({ file: 'src/a.test.tsx', line: i + 1, text }));
  assert.deepEqual(nonNullReads(lines).map(l => l.line), [1, 3]);
});
import { writeEntry, testFileHashes, provenTestFiles, skippedLines } from '../scripts/proof-record.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-test-asserts.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-asserts-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

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
  writeEntry(repo, 'page', { ok: true, breaks: 1, files: testFileHashes(repo, ['src/form.test.ts']), targets: targets() });
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 "nothing happens" check\(s\) proven by a break run\)/);
  fs.appendFileSync(path.join(repo, 'src/form.test.ts'), "it('[C1] again', () => { expect(x).toBeNull(); });\n");
  assert.equal(run().status, 1, 'a test edit after the proof needs a new proof run');
  writeEntry(repo, 'page', { ok: true, breaks: 0, files: testFileHashes(repo, ['src/form.test.ts']), targets: targets() });
  assert.equal(run().status, 1, 'an old-code run alone is not a break proof');
  fs.writeFileSync(check, '- saves nothing\n- shows once\n');
  writeEntry(repo, 'page', { ok: true, breaks: 1, files: testFileHashes(repo, ['src/form.test.ts']), targets: targets() });
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNTAGGED: check line C2 has no new test tagged \[C2\]/);
});

// 2026-11-12 (S4/C5/S8): one record cleared every "nothing happens" check of both stacks; a frontend
// proof cleared backend checks, and a product change after the proof kept clearing them.
test('the command: a check counts as proven only when its own test file is in a current entry; a changed break target voids the entry', () => {
  const repo = fs.mkdtempSync(path.join(root, 'stacks-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'rule.ts'), 'export const blocks = true;\n'); fs.writeFileSync(path.join(repo, 'Rule.cs'), 'class Rule {}\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'Api.Tests'));
  fs.writeFileSync(path.join(repo, 'src/form.test.ts'), "it('saves nothing', () => { expect(api.create).not.toHaveBeenCalled(); });\n");
  fs.writeFileSync(path.join(repo, 'Api.Tests/RuleTests.cs'), '[Fact] public void Refuses() { rows.Should().BeEmpty(); }\n');
  const run = () => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main'], { encoding: 'utf8', windowsHide: true, env: process.env });
  writeEntry(repo, 'page', { ok: true, breaks: 1, files: testFileHashes(repo, ['src/form.test.ts']), targets: testFileHashes(repo, ['rule.ts']) });
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNPROVEN: Api\.Tests\/RuleTests\.cs:1/, 'a frontend proof does not prove a backend check');
  assert.doesNotMatch(r.stdout, /UNPROVEN: src\/form/);
  writeEntry(repo, 'server', { ok: true, breaks: 1, files: testFileHashes(repo, ['Api.Tests/RuleTests.cs']), targets: testFileHashes(repo, ['Rule.cs']) });
  r = run();
  assert.equal(r.status, 0, 'a second proof adds its entry; the first stays: ' + r.stdout);
  assert.deepEqual([...provenTestFiles(repo)].sort(), ['Api.Tests/RuleTests.cs', 'src/form.test.ts']);
  fs.writeFileSync(path.join(repo, 'rule.ts'), 'export const blocks = true; // reviewed\n');
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
