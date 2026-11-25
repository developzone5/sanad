// 2026-11-14: a breaks.json named mustFail ["[C1]"] and ["[C2]"]. The task's new tests were "[C1] shows the
// attempts used ..." and "[C2] shows the attempts used ...", but the same test file already held older "[C1]"
// and "[C2]" tests of earlier tickets. Every test whose title holds a part must fail, so the proof read NOT
// PROVED after a full run of every copy (~1.5 min). Such a part is now refused before any run.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalTop } from '../scripts/proof-record.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const roots = [];
// The fixtures must not see this machine's git settings (a test machine there sends runs away).
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-amb-git-')), 'config');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000,
  env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', ...env } });
after(() => {
  for (const root of roots) {
    run(['--repo', path.join(root, 'repo'), '--drop-copies']);
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
});
// The kept copies a proof of this repository would use (red-proof.mjs slotsRoot).
const copiesOf = (repo) => path.join(os.tmpdir(), 'red-proof-copies', crypto.createHash('sha1').update(canonicalTop(repo)).digest('hex').slice(0, 12));

// One rule flag per test; each run notes itself in ran.txt (outside the repository), so "nothing ran" is seen.
const RULE = 'module.exports = { chips: true, totals: true, attempts: true, limit: true };\n';
const OLD_C1 = '[C1] chips and cards show only the selected section';
const OLD_C2 = '[C2] choosing all classes shows the totals';
const NEW_C1 = '[C1] shows the attempts used for each student';
const NEW_C2 = '[C2] shows the attempts used beside the limit';
const failLine = (dotnet) => (dotnet
  ? '"  Failed " + name + " [12 ms]", "  Error Message:", "   Assert.True() Failure"'
  : '" FAIL  src/results.test.cjs > results > " + name, "AssertionError: expected 1 to be 0"');
const check = (dotnet = false) => [
  'const fs = require("node:fs");',
  'fs.appendFileSync(process.env.RAN_MARKER, "ran" + String.fromCharCode(10));',
  'const r = require("./rule.cjs");',
  'const fails = [];',
  `for (const [flag, name] of ${JSON.stringify([['chips', OLD_C1], ['totals', OLD_C2], ['attempts', NEW_C1], ['limit', NEW_C2]])})`,
  `  if (!r[flag]) fails.push(${failLine(dotnet)});`,
  'if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }',
  ''].join('\n');

// A repository whose base commit holds `base` and whose working tree then holds `change` (the task).
function repoWith(base, change) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-amb-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write(base); git('add', '-A'); git('commit', '-qm', 'earlier tickets');
  write(change);
  const marker = path.join(root, 'ran.txt'), breaks = path.join(root, 'breaks.json');
  const proof = (mustFails, extra = []) => {
    fs.writeFileSync(breaks, JSON.stringify(mustFails.map(([flag, mustFail]) => ({ name: `${flag} broken`, file: 'rule.cjs', find: `${flag}: true`, put: `${flag}: false`, mustFail }))));
    return run(['--repo', repo, '--base', 'HEAD', '--breaks', breaks, ...extra, '--', process.execPath, 'check.cjs'],
      { RAN_MARKER: marker, SANAD_STATE_DIR: path.join(root, 'state') });
  };
  return { repo, git, marker, proof };
}

const jsTests = (titles) => ["describe('results', () => {", ...titles.map(t => `  it('${t}', () => {});`), '});', ''].join('\n');
const jsRepo = () => repoWith(
  { 'rule.cjs': RULE, 'check.cjs': check(), 'src/results.test.cjs': jsTests([OLD_C1, OLD_C2]) },
  { 'src/results.test.cjs': jsTests([OLD_C1, OLD_C2, NEW_C1, NEW_C2]) });

test('the real case: "[C1]" and "[C2]" each name a new test and an older one, so the proof stops before any run (exit 2)', () => {
  const { repo, git, marker, proof } = jsRepo();
  const status = git('status', '--porcelain');
  const rule = fs.readFileSync(path.join(repo, 'rule.cjs'));
  const result = proof([['attempts', ['[C1]']], ['limit', ['[C2]']]], ['--then-green', '--parallel', '2']);
  assert.equal(result.status, 2, result.stdout);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(result.stdout, new RegExp(`BREAK AMBIGUOUS ✗ attempts broken: mustFail part "\\[C1\\]" holds new test\\(s\\) "${esc(NEW_C1)}" and older test\\(s\\) "${esc(OLD_C1)}"`));
  assert.match(result.stdout, new RegExp(`BREAK AMBIGUOUS ✗ limit broken: mustFail part "\\[C2\\]" holds new test\\(s\\) "${esc(NEW_C2)}" and older test\\(s\\) "${esc(OLD_C2)}"`));
  assert.match(result.stdout, /RED-PROOF: NOT PROVED ✗ — .*name each test by words of its own title.*Nothing ran; files untouched\./);
  assert.ok(!fs.existsSync(marker), 'no test run started (not green, not a break)');
  assert.ok(!fs.existsSync(copiesOf(repo)), 'no kept copy was made or synced');
  assert.doesNotMatch(result.stdout, /compile check|run\(s\),|ran green/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'rule.cjs')), rule);
  assert.equal(git('status', '--porcelain'), status, 'files untouched');
});

test('a part that holds only older titles is allowed: a break may name an existing test of the same rule', () => {
  const { marker, proof } = jsRepo();
  const result = proof([['chips', ['[C1] chips and cards']], ['totals', [OLD_C2]]], ['--parallel', '1']);
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /AMBIGUOUS/);
  assert.match(result.stdout, /BREAK ✓ chips broken: all 1 named test\(s\) fail/);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓/);
  assert.ok(fs.existsSync(marker), 'the runs ran');
});

test('a part that holds only new titles is allowed, and a part that holds no title keeps today\'s reading', () => {
  const { proof } = jsRepo();
  const result = proof([['attempts', ['[C1] shows the attempts']], ['limit', ['used beside the limit']]], ['--parallel', '1']);
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /AMBIGUOUS/);
  assert.match(result.stdout, /RED-PROOF: PROVED ✓ — 2 break\(s\) caught/);
  const none = proof([['attempts', ['no such title']]], ['--parallel', '1']);
  assert.equal(none.status, 1, none.stdout);
  assert.doesNotMatch(none.stdout, /AMBIGUOUS/);
  assert.match(none.stdout, /BREAK ✗ attempts broken: still pass \(or not seen failing\): no such title/);
});

test('C#: a part in a new DisplayName and an older one is refused; the new test\'s method name is allowed', () => {
  const cs = (tests) => ['public class ResultsTests {', ...tests.flatMap(([display, method]) => [
    `  [Fact(DisplayName = "${display}")]`, `  public void ${method}() { }`]), '}', ''].join('\n');
  const older = [OLD_C1, 'Chips_OnlySelectedSection'];
  const { marker, proof } = repoWith(
    { 'rule.cjs': RULE, 'check.cjs': check(true), 'Tests/ResultsTests.cs': cs([older]) },
    { 'Tests/ResultsTests.cs': cs([older, [NEW_C1, 'Attempts_ShownPerStudent']]) });
  const refused = proof([['attempts', ['[C1]']]], ['--parallel', '1']);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stdout, /BREAK AMBIGUOUS ✗ attempts broken: mustFail part "\[C1\]" holds new test\(s\) "\[C1\] shows the attempts used for each student" and older test\(s\) "\[C1\] chips and cards show only the selected section"/);
  assert.ok(!fs.existsSync(marker), 'nothing ran');
  const allowed = proof([['attempts', ['Attempts_ShownPerStudent']]], ['--parallel', '1']);
  assert.equal(allowed.status, 0, allowed.stdout);
  assert.match(allowed.stdout, /BREAK ✓ attempts broken: all 1 named test\(s\) fail/);
});

test('new and older tests, and which parts are ambiguous', async () => {
  const { markNewTests, ambiguousParts } = await import('../scripts/red-proof.mjs');
  const before = jsTests(['[C1] old one', 'same title', 'renamed before']);
  const now = jsTests(['[C1] old one', 'same title', 'same title', 'renamed after', '[C1] new one', 'shows the total']);
  const tests = markNewTests(now, before, 'src/a.test.cjs');
  assert.deepEqual(tests.map(t => [t.titles[0], t.isNew]), [
    ['[C1] old one', false], ['same title', false], ['same title', true], ['renamed after', true], ['[C1] new one', true], ['shows the total', true]],
    'a title the base had is older once per time it had it; a renamed title is new');
  assert.ok(markNewTests(now, null, 'src/a.test.cjs').every(t => t.isNew), 'a file the base did not have holds only new tests');
  const older = markNewTests(jsTests(['shows the total for all classes']), jsTests(['shows the total for all classes']), 'src/b.test.cjs');
  const all = [...tests, ...older];
  const brk = (mustFail) => [{ name: 'b', mustFail }];
  assert.deepEqual(ambiguousParts(brk(['[c1]']), all).map(u => [u.part, u.fresh, u.older]), [['[c1]', ['[C1] new one'], ['[C1] old one']]], 'matched in lower case, as survivors() does');
  assert.deepEqual(ambiguousParts(brk(['same title']), all).map(u => u.part), [], 'a whole title: no narrower words name that test');
  assert.deepEqual(ambiguousParts(brk(['shows the total']), all), [], 'a new whole title inside an older title is left alone');
  assert.deepEqual(ambiguousParts(brk(['shows the']), all).map(u => u.older), [['shows the total for all classes']], 'across test files');
  assert.deepEqual(ambiguousParts(brk(['old one', 'new one', 'nothing']), all), []);
  assert.deepEqual(ambiguousParts([{ name: 'one', single: true, file: 'x' }], all), [], 'a single --break has no mustFail');
});
