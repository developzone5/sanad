import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flatten, findQuote, readLines, normalize, TEST_FILE } from '../scripts/check-ticket-lines.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-ticket-lines.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-lines-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(files, { commitAll = true } = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('branch', 'base');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  }
  if (commitAll && Object.keys(files).length) { git('add', '-A'); git('commit', '-qm', 'work'); }
  return { repo, git };
}
function run(repo, lines, extra = []) {
  const file = path.join(fs.mkdtempSync(path.join(root, 'lines-')), 'lines.md');
  fs.writeFileSync(file, lines);
  const r = spawnSync(process.execPath, [script, '--lines', file, '--repo', repo, ...extra], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('a line quoted in a test name or a wrapped comment above a test is covered; the stop at the end does not matter', () => {
  const { repo } = fixture({
    'src/list.test.tsx': [
      "// STORY-12: «Selecting a count filters the list and replaces the tab.",
      "// Selecting it again clears it.»",
      "it('first', () => {});",
      "it(\"subject filter: every subject the teacher teaches\", () => {});",
    ].join('\n'),
  });
  const r = run(repo, '- "Selecting a count filters the list and replaces the tab. Selecting it again clears it."\n* Every subject the teacher teaches.\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 of 2 covered/);
  assert.match(r.out, /src\/list\.test\.tsx:1\b/);
  assert.match(r.out, /src\/list\.test\.tsx:4\b/);
});

// 2026-11-09: lines files number each line ("T6: …") but a test may quote only the line's own words.
test('a numbered line is covered by a test that quotes only its words', () => {
  const { repo } = fixture({
    'src/box.test.ts': [
      '// "The markdown options should appear at the top of the text area"',
      "it('[C1] keeps the toolbar first', () => {});",
    ].join('\n'),
  });
  const r = run(repo, 'T6: The markdown options should appear at the top of the text area\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 of 1 covered/);
});

test('a line with no quoting test fails, and so does a quote far from any test or in a non-test file', () => {
  const far = ['// Search matches the homework title.', ...Array(14).fill('const x = 1;'), "it('later', () => {});"].join('\n');
  const { repo } = fixture({ 'src/far.test.ts': far, 'src/page.tsx': "// Section filter resets to all sections\nit('not a test file', () => {});" });
  const r = run(repo, 'Search matches the homework title.\nSection filter resets to all sections\n');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /0 of 2 covered/);
  assert.match(r.out, /✗ L1 "Search matches the homework title\."/);
  assert.match(r.out, /✗ L2/);
});

test('each sentence may be proved by its own test', () => {
  const { repo } = fixture({
    'tests/a.test.js': "test('selecting a count filters the list', () => {});\n",
    'tests/b.test.js': "test('selecting it again clears it', () => {});\n",
  });
  const r = run(repo, 'Selecting a count filters the list. Selecting it again clears it.\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tests\/a\.test\.js:1, tests\/b\.test\.js:1/);
});

test('one sentence proved and one not is not covered', () => {
  const { repo } = fixture({ 'tests/a.test.js': "test('selecting a count filters the list', () => {});\n" });
  const r = run(repo, 'Selecting a count filters the list. Selecting it again clears it.\n');
  assert.equal(r.code, 1, r.out);
});

test('with --base, the covering test is labelled changed or unchanged, and the changed one is credited first', () => {
  const { repo, git } = fixture({});
  fs.mkdirSync(path.join(repo, 'old'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'old', 'x.test.ts'), "it('the counts follow the subject filter', () => {});\n");
  git('add', '-A'); git('commit', '-qm', 'old test'); git('branch', '-f', 'base');
  fs.mkdirSync(path.join(repo, 'new'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'new', 'y.test.ts'), "it('the counts follow the subject filter', () => {});\nit('drafts are not published yet', () => {});\n");
  const r = run(repo, 'The counts follow the subject filter\nDrafts are not published yet\n', ['--base', 'base']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new\/y\.test\.ts:1 \(changed\)/, 'an untracked new test counts as changed and wins');
  const old = run(repo, 'The counts follow the subject filter\n', ['--base', 'HEAD']);
  assert.match(old.out, /\(changed\)|\(unchanged\)/);
});

// 2026-11-12 (audit C11): any test file that quoted a line covered it, also an old test of an earlier
// ticket that the branch never touched.
test('with --base, a line quoted only in an unchanged test fails and names that test; with no base it passes', () => {
  const { repo, git } = fixture({});
  fs.mkdirSync(path.join(repo, 'old'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'old', 'x.test.ts'), "it('the counts follow the subject filter', () => {});\n");
  git('add', '-A'); git('commit', '-qm', 'old test'); git('branch', '-f', 'base');
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n'); git('commit', '-qam', 'work');
  const r = run(repo, 'The counts follow the subject filter\n', ['--base', 'base']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /0 of 1 covered/);
  assert.match(r.out, /✗ L1 "The counts follow the subject filter" — quoted only in an older test \(unchanged\): old\/x\.test\.ts:1/);
  assert.equal(run(repo, 'The counts follow the subject filter\n').code, 0, 'no base: any test file counts, as before');
});

test('with --base, a line quoted in a test file the branch changed is covered', () => {
  const { repo, git } = fixture({});
  fs.mkdirSync(path.join(repo, 'old'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'old', 'x.test.ts'), "it('an older case', () => {});\n");
  git('add', '-A'); git('commit', '-qm', 'old test'); git('branch', '-f', 'base');
  fs.appendFileSync(path.join(repo, 'old', 'x.test.ts'), "it('drafts are not published yet', () => {});\n");
  git('commit', '-qam', 'work');
  const r = run(repo, 'Drafts are not published yet\n', ['--base', 'base']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ L1 .*old\/x\.test\.ts:2 \(changed\)/);
});

// 2026-11-12 (audit C21): the 12 lines to the test were counted from the quote's first line, so a long
// quote wrapped over many comment lines never reached its test.
test('the window to the test declaration is counted from the last line of the quote', () => {
  const src = [
    '// "When the teacher opens the list',
    '// the counts follow',
    '// the subject filter',
    '// and the section filter',
    '// and the search box',
    '// and the date range."',
    ...Array(8).fill('// setup notes'),
    "it('[C1] counts', () => {});",
  ].join('\n');
  const line = 'When the teacher opens the list the counts follow the subject filter and the section filter and the search box and the date range.';
  assert.equal(findQuote(flatten(src), normalize(line).replace(/[.]+$/, '')), 1);
  const { repo } = fixture({ 'src/long.test.ts': src });
  const r = run(repo, line + '\n');
  assert.equal(r.code, 0, r.out);
});

test('a lines file written as "T1. text" reads like "T1: text"', () => {
  assert.deepEqual(readLines('T1. The list shows every subject\nT2: Drafts stay hidden\n'), ['T1: The list shows every subject', 'T2: Drafts stay hidden']);
  const { repo } = fixture({ 'src/t.test.ts': "// \"The counts follow the subject filter\"\nit('[C1] counts', () => {});\n" });
  const r = run(repo, 'T1. The counts follow the subject filter\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ L1 "T1: The counts follow the subject filter"/);
});

// 2026-11-12 (audit C10): a ticket line quoted above a skipped test read as tested, though the test never runs.
test('a quote above a skipped or todo test does not count; the same quote above a running test does', () => {
  const quote = '// "The message should appear once."';
  const needle = normalize('The message should appear once');
  for (const decl of ["it.skip('shows it once', () => {});", "it.todo('shows it once');", "test.skip('shows it once', () => {});",
    "describe.skip('message', () => {});", "xit('shows it once', () => {});", '[Fact(Skip = "later")]', '[Theory(Skip = "later")]']) {
    assert.equal(findQuote(flatten(`${quote}\n${decl}`), needle), 0, decl);
  }
  assert.equal(findQuote(flatten(`${quote}\nit('shows it once', () => {});`), needle), 1);
  assert.equal(findQuote(flatten(`${quote}\n[Fact]\npublic void ShowsItOnce() {}`), needle), 1);
  // A skipped copy first, then a real test that quotes it again: the real one counts.
  assert.equal(findQuote(flatten(`${quote}\nit.skip('old', () => {});\n\n\n\n\n\n\n\n\n\n\n\n\n\n${quote}\nit('new', () => {});`), needle), 16);
});

test('C# and Python test shapes count as tests', () => {
  const { repo } = fixture({
    'Api.Tests/HomeworkTests.cs': '// A teacher sees only own sections\n[Fact]\npublic void Sections() {}\n',
    'tests/test_list.py': '# Late hand-ins show the late tag\ndef test_late():\n    pass\n',
  });
  const r = run(repo, 'A teacher sees only own sections.\nLate hand-ins show the late tag.\n');
  assert.equal(r.code, 0, r.out);
});

test('usage errors exit 2', () => {
  const { repo } = fixture({});
  assert.equal(run(repo, '# only a comment\n\n').code, 2);
  assert.equal(spawnSync(process.execPath, [script, '--lines'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' }).status, 2);
});

test('helpers: quotes, case and comment markers are ignored; list markers are dropped', () => {
  assert.equal(normalize('  «Selecting» “it”  AGAIN '), 'selecting it again');
  assert.deepEqual(readLines('# head\n- one line here\n2. two line here\n\n"three line here"\n'), ['one line here', 'two line here', 'three line here']);
  const f = flatten('/* Selecting it\n * again clears it */\ndescribe("x", () => {});');
  assert.equal(findQuote(f, 'selecting it again clears it'), 1);
  assert.ok(TEST_FILE.test('src/pages/x.test.tsx') && TEST_FILE.test('App.Tests/Foo.cs') && !TEST_FILE.test('src/pages/x.tsx'));
});
