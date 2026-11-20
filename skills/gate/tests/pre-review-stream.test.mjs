import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 2026-11-19: pre-review waited for every check and printed once at the end, so two instant failures showed only
// after the slowest check (96 s). Each check's lines are now printed when that check ends; the summary comes last.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-stream-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const { preReview } = await import('../scripts/pre-review.mjs');

// A repository with one changed doc: the plan is test asserts, commits, size and one job.
function fixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  fs.writeFileSync(path.join(repo, 'README.md'), 'two\n');
  return { repo, git };
}
// A fake check: it ends after `ms[name]` (default 1 ms) with `out[name]` and `code[name]` (default 0).
const fake = ({ ms = {}, out = {}, code = {}, seen = [] } = {}) => (c) => new Promise((resolve) => {
  seen.push(c.name);
  setTimeout(() => resolve({ ...c, code: code[c.name] || 0, out: out[c.name] || '', ms: ms[c.name] || 1 }), ms[c.name] || 1);
});
const TINY = 'SIZE: tiny (diff) — docs, tests, texts or styles only';

test('three checks of 0.1 s, 1 s and 3 s print their lines at those times, and the summary comes last', async () => {
  const { repo } = fixture();
  // Times are counted from the moment the checks start (reading the change set comes before it).
  let start = 0;
  const printed = [], timed = fake({ ms: { commits: 100, size: 1000, 'one job': 3000 }, out: { size: TINY } });
  const r = await preReview({ repo, base: 'base', node: process.execPath, remote: null, noCache: true,
    run: (c) => { start = start || Date.now(); return timed(c); },
    print: (text) => printed.push({ at: Date.now() - start, text }) });
  assert.equal(r.ok, true, r.text);
  const at = (name) => printed.find(p => p.text.startsWith(`  ✓ ${name} `)).at;
  assert.ok(at('commits') < 900, `the 0.1 s check is printed when it ends, not with the slow ones: ${at('commits')} ms`);
  assert.ok(at('size') >= 900 && at('size') < 2800, `the 1 s check at about 1 s: ${at('size')} ms`);
  assert.ok(at('one job') >= 2800, `the 3 s check at about 3 s: ${at('one job')} ms`);
  assert.ok(at('commits') < at('size') && at('size') < at('one job'));
  assert.match(printed.at(-1).text, /^PRE-REVIEW: 4 of 4 checks passed · 5 skipped: ticket lines, test labels, size growth, places, siblings · 1 changed file/, 'the summary is the last thing printed');
  assert.equal(printed.filter(p => /^PRE-REVIEW/.test(p.text)).length, 1, 'and it is printed once');
  // What preReview gives back keeps its shape: the summary first, then the plan's order.
  const lines = r.text.split('\n');
  assert.match(lines[0], /^PRE-REVIEW: 4 of 4 checks passed/);
  assert.deepEqual(lines.filter(l => /^ {2}✓ /.test(l)).map(l => l.replace(/ \(.*$/, '').trim()), ['✓ test asserts', '✓ commits', '✓ size', '✓ one job']);
});

test('an instant failure is printed at once, with its lines, while a slow check still runs', async () => {
  const { repo } = fixture();
  // Count from the first check start: reading the change set (git calls) comes before it and is slow on a busy
  // machine. That wait was the cause of a flaky failure; the code prints at once.
  let start = 0;
  const printed = [], timed = fake({ ms: { 'one job': 3000 }, out: { size: TINY, commits: '✗ the subject does not end with the ticket ID' }, code: { commits: 1 } });
  const r = await preReview({ repo, base: 'base', node: process.execPath, remote: null, noCache: true,
    run: (c) => { start = start || Date.now(); return timed(c); },
    print: (text) => printed.push({ at: Date.now() - start, text }) });
  assert.equal(r.ok, false);
  const failed = printed.find(p => p.text.startsWith('  ✗ commits'));
  assert.ok(failed && failed.at < 2500, 'printed long before the slow check ends: ' + JSON.stringify(failed));
  assert.match(failed.text, /\n {6}✗ the subject does not end with the ticket ID/);
  assert.match(printed.at(-1).text, /^PRE-REVIEW: 3 of 4 checks passed/);
});

test('the places line waits for the size check, and a missing list is named as soon as the size check ends', async () => {
  const { repo } = fixture();
  const places = path.join(root, 'places-wait.md');
  fs.writeFileSync(places, '# Places\n\nRepo: x\nNames: a\n');
  let printed = [];
  await preReview({ repo, base: 'base', node: process.execPath, remote: null, noCache: true, places,
    run: fake({ ms: { size: 400 }, out: { size: 'SIZE: small (diff) — behavior code with no risk signal', places: 'PLACES: 1 place(s), 0 open' } }),
    print: (text) => printed.push(text) });
  const index = (start) => printed.findIndex(t => t.startsWith(start));
  assert.ok(index('  ✓ places') > index('  ✓ size'), 'places ended first, and is printed after the size check: ' + printed.join(' | '));
  // No --places and no --siblings on a change that is not text only: both NOT RUN lines come with the size line.
  printed = [];
  const r = await preReview({ repo, base: 'base', node: process.execPath, remote: null, noCache: true,
    run: fake({ ms: { 'one job': 300 }, out: { size: 'SIZE: small (diff) — behavior code with no risk signal' } }),
    print: (text) => printed.push(text) });
  assert.equal(r.ok, false);
  assert.ok(index('  ✗ places — NOT RUN') > index('  ✓ size') && index('  ✗ places — NOT RUN') < index('  ✓ one job'), printed.join(' | '));
  assert.ok(index('  ✗ siblings — NOT RUN') < index('  ✓ one job'));
  assert.match(r.text, /✗ places — NOT RUN\n\s+list every place/, 'a check that could not run still shows NOT RUN and fails');
});

test('--part code runs lint and types only; --part lists runs the list checks and the size check', async () => {
  const { repo, git } = fixture();
  fs.mkdirSync(path.join(repo, 'web/src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'web/node_modules/eslint/bin'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'web/node_modules/typescript/bin'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'web/package.json'), '{"name":"web"}\n');
  fs.writeFileSync(path.join(repo, 'web/tsconfig.app.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'web/.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'web/node_modules/eslint/bin/eslint.js'), '');
  fs.writeFileSync(path.join(repo, 'web/node_modules/typescript/bin/tsc'), '');
  fs.writeFileSync(path.join(repo, 'web/src/a.ts'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'web'); git('branch', '-f', 'base');
  fs.writeFileSync(path.join(repo, 'web/src/a.ts'), 'export const a = 2;\n');
  const lines = path.join(root, 'part-lines.md'), places = path.join(root, 'part-places.md'), siblings = path.join(root, 'part-siblings.md');
  fs.writeFileSync(lines, '- the value is two\n'); fs.writeFileSync(places, '# Places\n\nRepo: x\nNames: zzz\n'); fs.writeFileSync(siblings, '# Siblings\n');
  const opts = { repo, base: 'base', node: process.execPath, remote: null, noCache: true, lines, places, siblings };
  let seen = [];
  const code = await preReview({ ...opts, part: 'code', run: fake({ seen }) });
  assert.deepEqual(seen.sort(), ['lint web (1 file)', 'types web']);
  assert.match(code.text, /^PRE-REVIEW \(part: code\): 2 of 2 checks passed · 1 changed file\(s\)/);
  assert.doesNotMatch(code.text, /skipped|NOT RUN/, 'nothing of the other half is named or owed');
  seen = [];
  const lists = await preReview({ ...opts, part: 'lists', run: fake({ seen, out: { size: 'SIZE: small (diff) — x' } }) });
  assert.deepEqual(seen.sort(), ['places', 'siblings', 'size', 'ticket lines']);
  assert.match(lists.text, /^PRE-REVIEW \(part: lists\): 4 of 4 checks passed/);
});
