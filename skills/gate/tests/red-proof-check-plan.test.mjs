// 2026-11-19: the checks a proof makes before any run cost a full start each time they refused: 8 unproven checks
// were shown 3 lines per file and took two tries. --check-plan runs those checks alone, in seconds: no test machine,
// no copy, no run. A usage refusal now ends with one fixed last line; the refusals that judge the break plan keep
// their own text. --at pins the proof to a commit, and the FOREIGN? guard runs before any run.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalTop } from '../scripts/proof-record.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'red-proof.mjs');
const roots = [];
// The fixtures must not see this machine's git settings (a test machine there sends runs away).
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-plan-git-')), 'config');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const gitEnv = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const node = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...gitEnv, ...env } });
after(() => {
  for (const root of roots) {
    node(script, ['--repo', path.join(root, 'repo'), '--drop-copies']);
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
});
const copiesOf = (repo) => path.join(os.tmpdir(), 'red-proof-copies', crypto.createHash('sha1').update(canonicalTop(repo)).digest('hex').slice(0, 12));
const REFUSED = 'RED-PROOF: REFUSED — nothing ran';
const lastLine = (r) => r.stdout.trimEnd().split(/\r?\n/).pop();

// Each run notes itself in ran.txt (outside the repository), so "nothing ran" is seen.
const RULE = 'module.exports = { saves: true, cleans: true };\n';
const CHECK = [
  'const fs = require("node:fs");',
  'fs.appendFileSync(process.env.RAN_MARKER, "ran" + String.fromCharCode(10));',
  'const r = require("./rule.cjs"), fails = [];',
  'if (!r.saves) fails.push(" FAIL  src/save.test.cjs > save > saves nothing on a closed form", "AssertionError: expected 1 to be 0");',
  'if (!r.cleans) fails.push(" FAIL  src/clean.test.cjs > clean > cleans the list", "AssertionError: expected 2 to be 1");',
  'if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n');
const CLEAN_JS = ["describe('clean', () => {", "  it('cleans the list', () => {", "    expect(list).toEqual(['a']);", '  });', '});', ''].join('\n');
// `count` tests, each with one new "nothing happens" check.
const nothingTests = (count) => ["describe('save', () => {",
  ...Array.from({ length: count }, (_, k) => [`  it('never saves case ${k + 1}', () => {`, `    expect(api.save${k + 1}).toHaveBeenCalledTimes(0);`, '  });']).flat(), '});', ''].join('\n');

// The base commit holds the rule; the working tree adds the new tests (untracked), as a task's tree does.
function fixture(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-plan-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...gitEnv } }).trim();
  const write = (list) => { for (const [f, text] of Object.entries(list)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write({ 'rule.cjs': RULE, 'check.cjs': CHECK }); git('add', '-A'); git('commit', '-qm', 'base');
  write({ 'src/clean.test.cjs': CLEAN_JS, ...files });
  const marker = path.join(root, 'ran.txt'), breaks = path.join(root, 'breaks.json'), env = { RAN_MARKER: marker, SANAD_STATE_DIR: path.join(root, 'state') };
  const proof = (list, extra = []) => {
    if (list) fs.writeFileSync(breaks, JSON.stringify(list));
    return node(script, ['--repo', repo, '--base', 'HEAD', ...(list ? ['--breaks', breaks] : []), ...extra, '--', process.execPath, 'check.cjs'], env);
  };
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
  return { root, repo, git, write, ran, env, proof };
}
const cleans = { name: 'cleans broken', file: 'rule.cjs', find: 'cleans: true', put: 'cleans: false', mustFail: ['cleans the list'] };
const nothingRan = (f) => { assert.equal(f.ran(), 0, 'no test run started'); assert.ok(!fs.existsSync(copiesOf(f.repo)), 'no kept copy was made'); };

test('--check-plan on a good plan prints PLAN OK as its last line, runs nothing, takes no copy and does not go to the test machine', () => {
  const f = fixture();
  // A test machine is set: a real proof would sync to it first. The plan check must not.
  f.git('config', 'sanad.remoteHost', 'no-such-host.invalid');
  const log = path.join(f.root, 'proof.log');
  fs.writeFileSync(log, 'an earlier proof\n');
  const r = f.proof([cleans], ['--check-plan', '--then-green', '--log', log]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lastLine(r), 'PLAN OK');
  assert.doesNotMatch(r.stdout, /REMOTE-DOWN|RED-PROOF: on |not synced/, 'the test machine was not contacted');
  nothingRan(f);
  assert.equal(fs.readFileSync(log, 'utf8'), 'an earlier proof\n', 'the log of an earlier proof is left alone');
  assert.ok(!fs.existsSync(path.join(f.root, 'state', 'proof', 'runs')), 'no run record: nothing ran');
});

test('--check-plan: a find that matches twice is refused with its own text (exit 2), not the usage line', () => {
  const f = fixture();
  const r = f.proof([{ ...cleans, find: 'true' }], ['--check-plan']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /break "cleans broken" matches 2 time\(s\) in rule\.cjs; it must match exactly once\. Nothing changed\./);
  assert.doesNotMatch(r.stdout, /REFUSED — nothing ran|PLAN OK/);
  nothingRan(f);
});

test('--check-plan: an ambiguous mustFail part is refused with its own text (exit 2), not the usage line', () => {
  const f = fixture();
  // An older test and a new one share the tag "[C1]".
  f.write({ 'src/old.test.cjs': ["it('[C1] keeps the old rule', () => {", '  expect(1).toBe(1);', '});', ''].join('\n') });
  f.git('add', '-A'); f.git('commit', '-qm', 'older test');
  f.git('branch', 'start');
  f.write({ 'src/old.test.cjs': ["it('[C1] keeps the old rule', () => {", '  expect(1).toBe(1);', '});', "it('[C1] cleans the new way', () => {", '  expect(2).toBe(2);', '});', ''].join('\n') });
  const r = f.proof([{ ...cleans, mustFail: ['[C1]'] }], ['--check-plan', '--base', 'start']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /BREAK AMBIGUOUS ✗ cleans broken: mustFail part "\[C1\]"/);
  assert.doesNotMatch(r.stdout, /REFUSED — nothing ran|PLAN OK/);
  nothingRan(f);
});

test('8 unproven checks in one file: every one of the 8 lines is printed (3 were), with its own text and no usage line', () => {
  const f = fixture({ 'src/save.test.cjs': nothingTests(8) });
  const r = f.proof([cleans], ['--check-plan']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /UNPROVEN ✗ src\/save\.test\.cjs: 8 new "nothing happens" check\(s\)/);
  for (let k = 1; k <= 8; k++) assert.match(r.stdout, new RegExp(`src/save\\.test\\.cjs:${3 * k} — expect\\(api\\.save${k}\\)\\.toHaveBeenCalledTimes\\(0\\);`), `line of case ${k}`);
  assert.doesNotMatch(r.stdout, /more line\(s\) not shown|REFUSED — nothing ran|PLAN OK/);
  nothingRan(f);
  // The same refusal without --check-plan: the same 8 lines.
  const full = f.proof([cleans], ['--then-green']);
  assert.equal(full.status, 2, full.stdout);
  assert.equal((full.stdout.match(/toHaveBeenCalledTimes\(0\); →/g) || []).length, 8);
  nothingRan(f);
});

test('45 unproven checks: 40 lines, then a count of the rest', () => {
  const f = fixture({ 'src/save.test.cjs': nothingTests(45) });
  const r = f.proof([cleans], ['--check-plan']);
  assert.equal(r.status, 2, r.stdout);
  assert.equal((r.stdout.match(/toHaveBeenCalledTimes\(0\); →/g) || []).length, 40);
  assert.match(r.stdout, /… and 5 more line\(s\) not shown/);
});

test('--check-plan names an entry that is not filled in (a seed entry with an empty file, find or put)', () => {
  const f = fixture();
  const r = f.proof([cleans, { name: 'saves nothing on a closed form', file: '', find: '', put: '', mustFail: ['saves nothing on a closed form'] },
    { ...cleans, name: 'no put yet', put: '' }], ['--check-plan']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /BREAK EMPTY ✗ saves nothing on a closed form: its file, find, put are empty/);
  assert.match(r.stdout, /BREAK EMPTY ✗ no put yet: its put is empty/);
  assert.match(r.stdout, /2 of 3 break\(s\) are not filled in\. Nothing ran; files untouched\./);
  assert.doesNotMatch(r.stdout, /PLAN OK/);
  nothingRan(f);
  // A real run names the empty find too, and still takes an empty put (a break that deletes text).
  const real = f.proof([{ name: 'seed', file: 'rule.cjs', find: '', put: '', mustFail: ['cleans the list'] }], ['--parallel', '1']);
  assert.equal(real.status, 2, real.stdout);
  assert.match(real.stdout, /BREAK EMPTY ✗ seed: its find is empty/);
  nothingRan(f);
});

test('--check-plan: a mustFail part that names no test is refused; a part that names an older test in another file passes', () => {
  const f = fixture();
  const r = f.proof([{ ...cleans, mustFail: ['cleans the list', 'words no test holds anywhere'] }], ['--check-plan']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /BREAK UNNAMED ✗ cleans broken: mustFail part "words no test holds anywhere" names no test/);
  assert.doesNotMatch(r.stdout, /PLAN OK/);
  // "saves nothing on a closed form" is no title of a changed test file, but check.cjs (an older file) holds it.
  const older = f.proof([{ ...cleans, mustFail: ['cleans the list', 'saves nothing on a closed form'] }], ['--check-plan']);
  assert.equal(older.status, 0, older.stdout);
  assert.equal(lastLine(older), 'PLAN OK');
  nothingRan(f);
});

test('every usage refusal ends with the exact last line "RED-PROOF: REFUSED — nothing ran" and exit 2', () => {
  const f = fixture();
  const cases = [
    ['--changed-since without --breaks', () => f.proof(null, ['--old', 'HEAD', '--files', 'rule.cjs', '--changed-since', 'HEAD'])],
    ['--changed-since with no ref', () => f.proof([cleans], ['--changed-since', '--then-green'])],
    ['an unknown --changed-since ref', () => f.proof([cleans], ['--changed-since', 'no-such-ref'])],
    ['--files names a test file', () => f.proof(null, ['--old', 'HEAD', '--files', 'src/clean.test.cjs'])],
    ['cmd.exe without /c', () => node(script, ['--repo', f.repo, '--break', 'rule.cjs', '--find', 'cleans: true', '--put', 'cleans: false', '--', 'cmd.exe', 'run.cmd'], f.env)],
    ['an unknown --at commit', () => f.proof([cleans], ['--at', 'no-such-commit'])],
  ];
  for (const [name, run] of cases) {
    const r = run();
    assert.equal(r.status, 2, name + ': ' + r.stdout);
    assert.equal(lastLine(r), REFUSED, name + ': ' + r.stdout);
    assert.equal((r.stdout.match(/REFUSED — nothing ran/g) || []).length, 1, name);
  }
  nothingRan(f);
});

test('--at: a dirty tree or another HEAD is refused before any run; the tree at that commit goes on', () => {
  const f = fixture();
  const first = f.git('rev-parse', 'HEAD');
  // The new test file is untracked: the tree is not the commit.
  const dirty = f.proof([cleans], ['--at', first, '--check-plan']);
  assert.equal(dirty.status, 2, dirty.stdout);
  assert.match(dirty.stdout, /--at [0-9a-f]{12}: the work tree is not that commit: 1 file\(s\) differ \(src\/clean\.test\.cjs\)/);
  assert.equal(lastLine(dirty), REFUSED);
  f.git('add', '-A'); f.git('commit', '-qm', 'the tests');
  const second = f.git('rev-parse', 'HEAD');
  // HEAD moved on: the pin names the older commit.
  const moved = f.proof([cleans], ['--at', first, '--base', 'HEAD~1', '--then-green', '--parallel', '1']);
  assert.equal(moved.status, 2, moved.stdout);
  assert.match(moved.stdout, new RegExp(`--at ${first.slice(0, 12)}: the work tree is at ${second.slice(0, 12)}, not at that commit`));
  assert.equal(lastLine(moved), REFUSED);
  nothingRan(f);
  // At the pinned commit, clean: the proof goes on (here the plan check, then a real run).
  const ok = f.proof([cleans], ['--at', second, '--base', 'HEAD~1', '--check-plan']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(lastLine(ok), 'PLAN OK');
  const real = f.proof([cleans], ['--at', second, '--base', 'HEAD~1', '--then-green', '--parallel', '1']);
  assert.equal(real.status, 0, real.stdout);
  assert.match(real.stdout, /RED-PROOF: PROVED ✓/);
  assert.equal(f.git('status', '--porcelain'), '', 'the tree is still the commit after the proof');
});

test('the FOREIGN? guard runs before any run: a folder of 201 untracked files is named and the proof is refused', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repo, 'other-session'));
  for (let k = 0; k < 201; k++) fs.writeFileSync(path.join(f.repo, 'other-session', `f${k}.txt`), 'x\n');
  const r = f.proof([cleans], ['--then-green', '--parallel', '1']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /^FOREIGN\? other-session\/? holds 201 untracked files/m);
  assert.equal(lastLine(r), REFUSED);
  nothingRan(f);
});
