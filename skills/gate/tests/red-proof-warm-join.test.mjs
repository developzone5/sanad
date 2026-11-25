// 2026-11-19: a kept copy was marked "built" after a build that failed (--warm) and after any run that ended (a
// break that did not compile). The next dotnet run then went to a copy that had never built, and compiled the whole
// solution. A copy is now marked built only after a build that ended with exit 0, or a run whose output shows the
// build finished. A proof also builds its own cold copies first (red-proof.test.mjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalTop } from '../scripts/proof-record.mjs';
import { buildFinished } from '../scripts/red-proof.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'red-proof.mjs');
const roots = [];
const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-warm-git-')), 'config');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const gitEnv = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const node = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...gitEnv, ...env } });
// A `dotnet` that is Node under that name: `dotnet test` then runs test.js of the folder it starts in.
const fakeDotnet = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-warm-dotnet-'));
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
const built = (repo, k) => fs.existsSync(path.join(copiesOf(repo), String(k), '.git', 'red-proof-built'));

// test.js is the fake solution: `--list-tests` is its build (it fails while the BUILD_FAILS file is there); a run
// fails to compile when the rule is broken, as a break that does not compile does.
const TEST_JS = [
  'const fs = require("node:fs");',
  'if (process.argv.includes("--list-tests")) process.exit(fs.existsSync(process.env.BUILD_FAILS) ? 1 : 0);',
  'if (!require("./rule.cjs").compiles) { console.log("Rule.cs(3,9): error CS1002: ; expected" + String.fromCharCode(10) + "Build FAILED."); process.exit(1); }', ''].join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-warm-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...gitEnv } }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'test.js'), TEST_JS);
  fs.writeFileSync(path.join(repo, 'rule.cjs'), 'module.exports = { compiles: true };\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const fails = path.join(root, 'build-fails');
  return { root, repo, fails, env: { BUILD_FAILS: fails, SANAD_STATE_DIR: path.join(root, 'state') } };
}

test('--warm: a copy whose build exits 1 is not marked built; after a build that exits 0 it is', () => {
  const f = fixture();
  fs.writeFileSync(f.fails, '');
  const bad = node(script, ['--repo', f.repo, '--warm', '--parallel', '1', '--', fakeDotnet, 'test'], f.env);
  assert.equal(bad.status, 0, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /copy 0: build failed \(exit 1\)/);
  assert.equal(built(f.repo, 0), false, 'a failed build leaves the copy not built');
  fs.rmSync(f.fails);
  const good = node(script, ['--repo', f.repo, '--warm', '--parallel', '1', '--', fakeDotnet, 'test'], f.env);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /copy 0: built/);
  assert.equal(built(f.repo, 0), true);
});

test('a run whose build failed (a break that does not compile) does not mark its copy built', () => {
  const f = fixture();
  const breaks = path.join(f.root, 'breaks.json');
  fs.writeFileSync(breaks, JSON.stringify([{ name: 'does not compile', file: 'rule.cjs', find: 'compiles: true', put: 'compiles: false', mustFail: ['compiles'] }]));
  // `dotnet test.js` has no compile check of its own, so the copy's first build is this run.
  const r = node(script, ['--repo', f.repo, '--base', 'HEAD', '--breaks', breaks, '--parallel', '2', '--', fakeDotnet, 'test.js'], f.env);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /BREAK INVALID ✗ does not compile/);
  assert.equal(built(f.repo, 0), false, 'the build in that copy never finished');
});

test('buildFinished: a passing run, or a run that names failing tests or prints its totals with no build error', () => {
  assert.equal(buildFinished({ status: 0, stdout: '', stderr: '' }), true);
  assert.equal(buildFinished({ status: 1, stdout: '  Failed Save_Never_WhenClosed [12 ms]\n  Error Message:\n   Assert.True() Failure\n', stderr: '' }), true);
  assert.equal(buildFinished({ status: 1, stdout: 'Failed!  - Failed: 1, Passed: 39, Skipped: 0, Total: 40\n', stderr: '' }), true);
  assert.equal(buildFinished({ status: 1, stdout: 'Rule.cs(3,9): error CS1002: ; expected\nBuild FAILED.\n', stderr: '' }), false);
  assert.equal(buildFinished({ status: 1, stdout: '', stderr: 'MSBUILD : error MSB1009: Project file does not exist.\n' }), false, 'no sign that a test ran');
  assert.equal(buildFinished({ status: 1, stdout: '  Failed A [1 ms]\n', stderr: '', timedOut: true }), false);
  assert.equal(buildFinished({ status: null, stdout: '', stderr: '', error: new Error('spawn') }), false);
  assert.equal(buildFinished(undefined), false);
});

test('a usage refusal (no arguments) ends with the exact REFUSED line the stop hook reads, exit 2', () => {
  const f = fixture();
  const r = node(script, ['--repo', f.repo, '--', fakeDotnet, 'test'], f.env);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines[lines.length - 1], 'RED-PROOF: REFUSED — nothing ran');
});
