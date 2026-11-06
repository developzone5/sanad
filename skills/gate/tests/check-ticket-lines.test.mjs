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
