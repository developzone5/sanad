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
import { writeRecord, testFileHashes } from '../scripts/proof-record.mjs';

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
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNPROVEN: src\/form\.test\.ts:1/);
  writeRecord(repo, { ok: true, breaks: 1, files: testFileHashes(repo, ['src/form.test.ts']) });
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /TEST ASSERTS: none \(1 "nothing happens" check\(s\) proven by a break run\)/);
  fs.appendFileSync(path.join(repo, 'src/form.test.ts'), "it('[C1] again', () => { expect(x).toBeNull(); });\n");
  assert.equal(run().status, 1, 'a test edit after the proof needs a new proof run');
  writeRecord(repo, { ok: true, breaks: 0, files: testFileHashes(repo, ['src/form.test.ts']) });
  assert.equal(run().status, 1, 'an old-code run alone is not a break proof');
  fs.writeFileSync(check, '- saves nothing\n- shows once\n');
  writeRecord(repo, { ok: true, breaks: 1, files: testFileHashes(repo, ['src/form.test.ts']) });
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNTAGGED: check line C2 has no new test tagged \[C2\]/);
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
