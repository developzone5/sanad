// 2026-11-15: a proof read PROVED, then pre-review said UNPROVEN ×6: one test file's new "nothing happens" checks
// were proven only by the old-code run, and no break named a test in that file. Pre-review counts such a check
// only from a break run that named a test in its own file, so the whole proof (~5 minutes) ran again with one more
// break. Such a proof is now refused before any run.
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
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-nothing-git-')), 'config');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const gitEnv = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const node = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...gitEnv, ...env } });
// A `dotnet` that is Node under that name: red-proof reads the command as a dotnet one, and it runs check.cjs.
const fakeDotnet = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-nothing-dotnet-'));
  const exe = path.join(dir, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  return exe;
})();
after(() => {
  for (const root of roots) {
    node(script, ['--repo', path.join(root, 'repo'), '--drop-copies']);
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.rmSync(path.dirname(emptyConfig), { recursive: true, force: true });
  fs.rmSync(path.dirname(fakeDotnet), { recursive: true, force: true });
});
const copiesOf = (repo) => path.join(os.tmpdir(), 'red-proof-copies', crypto.createHash('sha1').update(canonicalTop(repo)).digest('hex').slice(0, 12));

// One rule flag per test. Run as node it prints vitest failures, run as dotnet the xUnit one; each run notes itself
// in ran.txt (outside the repository), so "nothing ran" is seen.
const RULE = 'module.exports = { saves: true, cleans: true };\n';
const CHECK = [
  'const fs = require("node:fs"), path = require("node:path");',
  'fs.appendFileSync(process.env.RAN_MARKER, "ran" + String.fromCharCode(10));',
  'const r = require("./rule.cjs"), fixed = require("./app.cjs") === 2, fails = [];',
  'if (/^dotnet/i.test(path.basename(process.execPath))) {',
  '  if (!r.saves) fails.push("  Failed Save_Never_WhenClosed [12 ms]", "  Error Message:", "   Assert.True() Failure");',
  '} else {',
  '  if (!r.saves) fails.push(" FAIL  src/save.test.cjs > save > saves nothing on a closed form", "AssertionError: expected 1 to be 0");',
  '  if (!r.cleans) fails.push(" FAIL  src/clean.test.cjs > clean > cleans the list", "AssertionError: expected 2 to be 1");',
  '  if (!fixed) fails.push(" FAIL  src/clean.test.cjs > clean > cleans the list", "AssertionError: expected 1 to be 2");',
  '}',
  'if (fails.length) { console.log(fails.join(String.fromCharCode(10))); process.exit(1); }', ''].join('\n');
const SAVE_JS = ["describe('save', () => {", "  it('saves nothing on a closed form', () => {", '    expect(api.save).toHaveBeenCalledTimes(0);', '  });', '});', ''].join('\n');
const CLEAN_JS = ["describe('clean', () => {", "  it('cleans the list', () => {", "    expect(list).toEqual(['a']);", '  });', '});', ''].join('\n');
const SAVE_CS = ['public class SaveTests {', '  [Fact]', '  public void Save_Never_WhenClosed() {', '    repo.Verify(r => r.Save(), Times.Never);', '  }', '}', ''].join('\n');

// The base commit holds the rule and the bug (app.cjs = 1); the working tree holds the fix and the new tests.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-nothing-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...gitEnv } }).trim();
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write({ 'rule.cjs': RULE, 'app.cjs': 'module.exports = 1;\n', 'check.cjs': CHECK }); git('add', '-A'); git('commit', '-qm', 'base');
  write({ 'app.cjs': 'module.exports = 2;\n', 'src/save.test.cjs': SAVE_JS, 'src/clean.test.cjs': CLEAN_JS, 'Tests/SaveTests.cs': SAVE_CS });
  const marker = path.join(root, 'ran.txt'), breaks = path.join(root, 'breaks.json'), env = { RAN_MARKER: marker, SANAD_STATE_DIR: path.join(root, 'state') };
  const writeBreaks = (list) => fs.writeFileSync(breaks, JSON.stringify(list.map(([flag, mustFail]) => ({ name: `${flag} broken`, file: 'rule.cjs', find: `${flag}: true`, put: `${flag}: false`, mustFail }))));
  // A proof by node (the page side) or by dotnet (the server side), with these breaks and options.
  const proof = (exe, list, extra = []) => {
    if (list) writeBreaks(list);
    return node(script, ['--repo', repo, '--base', 'HEAD', ...(list ? ['--breaks', breaks] : []), ...extra, '--', exe, 'check.cjs'], env);
  };
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
  return { repo, git, ran, env, proof };
}

// 2026-11-17 (audit: one caught test certified another rule's vacuous check in the same file): the refusal goes by
// the test that holds the check, not by its file, so its lines no longer say "names a test in this file" (the
// words this test held before); they name the test and the mustFail name that would prove it.
test('a "nothing happens" check whose test no break names: refused before any run (exit 2), the file, its line and its test named', () => {
  const { repo, git, ran, proof } = fixture();
  const status = git('status', '--porcelain');
  const rule = fs.readFileSync(path.join(repo, 'rule.cjs'));
  const result = proof(process.execPath, [['cleans', ['cleans the list']]], ['--old', 'HEAD', '--files', 'app.cjs', '--then-green', '--parallel', '2']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /UNPROVEN ✗ src\/save\.test\.cjs: 1 new "nothing happens" check\(s\) whose own test no break here names/);
  assert.match(result.stdout, /src\/save\.test\.cjs:3 — expect\(api\.save\)\.toHaveBeenCalledTimes\(0\); → its test "saves nothing on a closed form" is named by no caught break: a break of that test's rule whose mustFail names it \("saves nothing on a closed form"\) would prove it/);
  assert.match(result.stdout, /RED-PROOF: NOT PROVED ✗ — .*Add a break of each such test's rule whose mustFail names that test \(a run on the old code does not count for these lines\)\. Nothing ran; files untouched\./);
  assert.doesNotMatch(result.stdout, /SaveTests\.cs/, 'the C# file is the dotnet proof\'s: this node command does not run it');
  assert.doesNotMatch(result.stdout, /clean\.test\.cjs:/, 'a file with no "nothing happens" check is not named');
  assert.equal(ran(), 0, 'no test run started (not green, not the old code, not a break)');
  assert.ok(!fs.existsSync(copiesOf(repo)), 'no kept copy was made or synced');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'rule.cjs')), rule);
  assert.equal(git('status', '--porcelain'), status, 'files untouched');
});

test('--old with no --breaks is refused the same way: the old code never proves a "nothing happens" check', () => {
  const { ran, proof } = fixture();
  const result = proof(process.execPath, null, ['--old', 'HEAD', '--files', 'app.cjs']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /UNPROVEN ✗ src\/save\.test\.cjs/);
  assert.match(result.stdout, /a run on the old code does not count for these lines/);
  assert.equal(ran(), 0);
});

test('C# Times.Never: a dotnet proof whose breaks name no test in that file is refused; the node proof is not', () => {
  const { ran, proof } = fixture();
  const refused = proof(fakeDotnet, [['saves', ['saves nothing on a closed form']]], ['--parallel', '1']);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stdout, /UNPROVEN ✗ Tests\/SaveTests\.cs: 1 new "nothing happens" check\(s\)/);
  assert.match(refused.stdout, /Tests\/SaveTests\.cs:4 — repo\.Verify\(r => r\.Save\(\), Times\.Never\);/);
  assert.doesNotMatch(refused.stdout, /save\.test\.cjs:/, 'the page test file is the node proof\'s');
  assert.equal(ran(), 0);
});

test('with a break that names a test in each such file the proof runs; pre-review then finds nothing unproven', () => {
  const { repo, ran, env, proof } = fixture();
  const page = proof(process.execPath, [['saves', ['saves nothing on a closed form']], ['cleans', ['cleans the list']]], ['--old', 'HEAD', '--files', 'app.cjs', '--then-green', '--parallel', '1']);
  assert.equal(page.status, 0, page.stdout);
  assert.doesNotMatch(page.stdout, /UNPROVEN/);
  assert.match(page.stdout, /RED-PROOF: PROVED ✓ — red on the old code, 2 break\(s\) caught, green on the fix/);
  assert.ok(ran() > 0, 'the runs ran');
  const server = proof(fakeDotnet, [['saves', ['Save_Never_WhenClosed']]], ['--then-green', '--parallel', '1']);
  assert.equal(server.status, 0, server.stdout);
  assert.match(server.stdout, /BREAK ✓ saves broken: all 1 named test\(s\) fail/);
  // The check this refusal stands in for agrees: every "nothing happens" line is proven now.
  const asserts = node(path.join(scripts, 'check-test-asserts.mjs'), ['--repo', repo, '--base', 'HEAD'], env);
  assert.equal(asserts.status, 0, asserts.stdout + asserts.stderr);
  assert.match(asserts.stdout, /TEST ASSERTS: none \(2 "nothing happens" check\(s\) proven by a break run\)/);
  // --old alone leaves the record as it is: the files the break runs proved still count, so it runs.
  const old = proof(process.execPath, null, ['--old', 'HEAD', '--files', 'app.cjs']);
  assert.equal(old.status, 0, old.stdout);
  assert.match(old.stdout, /RED-PROOF: RED ✓/);
  // A --breaks run of the same command replaces its own record entry, so that entry's proof does not count for it.
  const again = proof(process.execPath, [['cleans', ['cleans the list']]], ['--parallel', '1']);
  assert.equal(again.status, 2, again.stdout);
  assert.match(again.stdout, /UNPROVEN ✗ src\/save\.test\.cjs/);
});

test('the test files a command runs: dotnet the C# ones, others the rest; the files its own words name, when it names some', async () => {
  const { proofScope } = await import('../scripts/red-proof.mjs');
  const files = ['Api/Api.Tests/SaveTests.cs', 'Api/Api.Tests/OtherTests.cs', 'web/src/a.test.tsx', 'web/src/features/x/b.test.tsx'];
  assert.deepEqual(proofScope(['dotnet', 'test', 'Api/Api.Tests/Api.Tests.csproj'], files), files.slice(0, 2), 'a project names no test file');
  assert.deepEqual(proofScope(['dotnet', 'test', '--filter', 'FullyQualifiedName~Api.Tests.SaveTests'], files), [files[0]], 'a class by its file name');
  assert.deepEqual(proofScope(['C:/x/dotnet.exe', 'test', '--filter=FullyQualifiedName~OtherTests'], files), [files[1]]);
  assert.deepEqual(proofScope(['node', 'node_modules/vitest/vitest.mjs', 'run'], files), files.slice(2), 'run is no path');
  assert.deepEqual(proofScope(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/a.test.tsx'], files), [files[2]], 'a path from the page folder');
  assert.deepEqual(proofScope(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src\\features\\'], files), [files[3]], 'a folder, either slash');
  assert.deepEqual(proofScope(['node', 'C:\\r\\web\\src\\a.test.tsx'], files), [files[2]], 'a full path');
  const two = [...files, 'admin/src/c.test.tsx'];
  assert.deepEqual(proofScope(['node', 'node_modules/vitest/vitest.mjs', 'run'], two, 'web'), files.slice(2), 'a command in a package folder runs that package\'s tests');
  assert.deepEqual(proofScope(['node', 'node_modules/vitest/vitest.mjs', 'run'], two, ''), two.slice(2), 'at the top, every page test file');
});

// 2026-11-15: check-test-asserts.mjs loaded review-brief.mjs, which loads red-proof.mjs; red-proof.mjs loading
// check-test-asserts.mjs back made `check-test-asserts.mjs --check` wait for itself and exit 13.
test('the shared "nothing happens" reading imports no script that loads red-proof, and check-test-asserts --check ends', () => {
  const imports = (f) => [...fs.readFileSync(path.join(scripts, f), 'utf8').matchAll(/\bimport\b[^;]*?\bfrom\s+['"]\.\/([\w.-]+\.mjs)['"]|\bimport\(\s*['"]\.\/([\w.-]+\.mjs)['"]/g)].map(m => m[1] || m[2]);
  const reach = new Set(['red-proof.mjs']);
  for (const f of reach) for (const g of imports(f)) reach.add(g);
  for (const f of [...reach].filter(f => f !== 'red-proof.mjs')) assert.ok(!imports(f).includes('red-proof.mjs'), `${f} is loaded by red-proof.mjs and loads it back`);
  assert.ok(!reach.has('check-test-asserts.mjs') && reach.has('new-lines.mjs'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-nothing-cycle-'));
  roots.push(repo);
  execFileSync('git', ['init', '-q', repo], { env: { ...process.env, ...gitEnv } });
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'base'], { env: { ...process.env, ...gitEnv } });
  const check = path.join(repo, 'check.md');
  fs.writeFileSync(check, '# Check\n');
  const result = node(path.join(scripts, 'check-test-asserts.mjs'), ['--repo', repo, '--base', 'HEAD', '--check', check]);
  assert.notEqual(result.status, 13, 'an unsettled top-level wait');
  assert.equal(result.signal, null, 'it ended by itself: ' + result.stdout + result.stderr);
});
