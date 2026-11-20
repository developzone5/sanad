// 2026-11-20 (V1): a proof sent to the test machine, from the side of the machine that asked.
// 1. The code id is taken before the sync; the tree the sync sent must be the tree the folder had then, or the run
//    saves nothing (no resume, no per-break save, no run facts) and prints one line.
// 2. The passing run's fact is saved when its line (RED-PROOF-GREEN) arrives, not only when the command ends well.
// 3. The caught lines carry the break id and the code id, and a break is resumed only when the session log shows it.
// ssh and scp are stand-ins that print what they are given (Git's echo.exe under those names on Windows).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { breakId, codeFingerprint, readRecord, recordKey } from '../scripts/proof-record.mjs';
import { gitBash } from '../scripts/git-bash.mjs';
import { isGreenLine, greenLine } from '../scripts/red-proof.mjs';

const redProof = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-v1-'));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = path.join(root, 'state'), projects = path.join(root, 'projects');
process.env.SANAD_STATE_DIR = state;
const env = (extra = {}) => ({ ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state, SANAD_PROJECTS_DIR: projects, CLAUDE_CODE_SESSION_ID: '', ...extra });
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const lines = (...l) => l.join('\n') + '\n';
const PRODUCT = lines("module.exports = { rows: () => [] };");
const CHECK = lines('const product = require("./product.cjs");', 'if (product.rows().length) { console.log(" FAIL  src/rows.test.cjs > refuses unauthorized rows"); process.exit(1); }');
const ROWS_TEST = lines("it('refuses unauthorized rows', () => {", '  expect(product.rows()).toEqual([]);', '});');
const ALLOW = { name: 'allow unauthorized rows', file: 'product.cjs', find: 'rows: () => []', put: 'rows: () => ["x"]', mustFail: ['refuses unauthorized rows'] };
const CAUGHT = 'RED-PROOF-CAUGHT: ' + Buffer.from(JSON.stringify({ i: 0, failed: [{ name: 'src/rows.test.cjs > refuses unauthorized rows', runner: 'vitest' }] })).toString('base64url');
const answer = (...said) => '\n' + said.join('\n') + '\n';

const standIn = (() => {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  if (process.platform !== 'win32') {
    // The run itself (the command that names red-proof.mjs) ends with $STANDIN_EXIT, every other call with 0.
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nprintf \'%s\\n\' "$*"\ncase "$*" in *red-proof.mjs*) exit ${STANDIN_EXIT:-0};; esac\nexit 0\n');
    fs.writeFileSync(path.join(bin, 'scp'), '#!/bin/sh\nprintf \'%s\\n\' "$*"\n');
    for (const name of ['ssh', 'scp']) fs.chmodSync(path.join(bin, name), 0o755);
    return { path: bin };
  }
  const tools = gitBash().tools;
  if (!tools || !fs.existsSync(path.join(tools, 'echo.exe'))) return null;
  for (const name of ['ssh', 'scp']) fs.copyFileSync(path.join(tools, 'echo.exe'), path.join(bin, name + '.exe'));
  return { path: bin + path.delimiter + tools };
})();
const skip = !standIn && 'no stand-in for ssh on this machine (Git for Windows has no echo.exe)';

let n = 0;
// main holds a product that leaves a row in; the working tree holds the fix and its test (and a document, which the code id leaves out).
function fixture() {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: env() }).trim();
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  write({ 'product.cjs': 'module.exports = { rows: () => ["left in"] };\n', 'check.cjs': CHECK, 'docs/guide.md': '# Guide\n' });
  git('add', '--all'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'task');
  write({ 'product.cjs': PRODUCT, 'src/rows.test.cjs': ROWS_TEST });
  const breaks = path.join(root, `breaks${n}.json`);
  // The proof's key holds its whole command, the stand-in's answer included.
  const keyOf = (said) => recordKey([process.execPath, 'check.cjs', said], '');
  // `tree`: the tree the stand-in sync names (default: the working tree, as the real sync sends it).
  const home = (tree = '$tree') => {
    for (const [k, v] of [['sanad.remoteHost', 'pc-test'], ['sanad.remoteRepo', 'C:/r/repo']]) git('config', k, v);
    const h = fs.mkdtempSync(path.join(root, 'home-'));
    const dir = path.join(h, '.claude', 'scripts', 'remote');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'remote-sync.sh'), ['#!/usr/bin/env bash', 'tmp=$(mktemp -d)', 'export GIT_INDEX_FILE="$tmp/index"', 'git read-tree HEAD', 'git add --all -- . 2>/dev/null',
      'tree=$(git write-tree)', 'unset GIT_INDEX_FILE', 'rm -rf "$tmp"', `echo "SYNCED pc-test $(git rev-parse HEAD) tree ${tree}"`, ''].join('\n'));
    const extra = { HOME: h, USERPROFILE: h };
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    extra[pathKey] = standIn.path + path.delimiter + process.env[pathKey];
    return extra;
  };
  const proof = (said, extra = {}, tree) => {
    fs.writeFileSync(breaks, JSON.stringify([ALLOW]));
    return spawnSync(process.execPath, [redProof, '--repo', repo, '--breaks', breaks, '--base', 'main', '--then-green', '--parallel', '1', '--', process.execPath, 'check.cjs', said],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, env: env({ ...home(tree), ...extra }) });
  };
  // The earlier command's result in this repository's session log, the way the host writes it.
  const log = (stdout, command = 'node red-proof.mjs --breaks b.json -- node check.cjs') => {
    const folder = path.join(projects, path.resolve(repo).replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(folder, { recursive: true });
    const id = 'toolu_' + n + '_' + Date.now();
    fs.appendFileSync(path.join(folder, 's1.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: stdout }] } }), ''].join('\n'));
  };
  return { repo, git, keyOf, proof, log };
}
// The order the test machine prints: the passing run's line, each caught break's line, then the report.
const FULL = answer(greenLine(), CAUGHT, '  BREAK ✓ allow unauthorized rows: all 1 named test(s) fail', '  GREEN ✓ the tests pass on the fixed tree');

test('the passing run line is read and not shown', () => {
  assert.equal(isGreenLine(greenLine() + '\r'), true);
  assert.equal(isGreenLine('  GREEN ✓ the tests pass on the fixed tree'), false);
});

test('the caught line of the report gets this machine\'s break id and code id; the passing-run fact is saved under that code id', { skip }, () => {
  const f = fixture();
  const r = f.proof(FULL);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const code = codeFingerprint(f.repo);
  assert.match(code, /^[0-9a-f]{40,64}$/);
  assert.ok(r.stdout.includes(`  BREAK ✓ allow unauthorized rows: all 1 named test(s) fail [break=${breakId(ALLOW)} tree=${code}]`), r.stdout);
  assert.doesNotMatch(r.stdout, /^RED-PROOF-GREEN/m, 'the line is read, not shown');
  assert.equal(readRecord(f.repo).runs[f.keyOf(FULL)][code].green, true);
});

test('the sync sent another tree than the folder had when the code id was taken: one line, nothing saved, no tail', { skip }, () => {
  const f = fixture();
  const r = f.proof(FULL, {}, "$(git rev-parse 'HEAD^{tree}')");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split(/\r?\n/).filter(l => /^RED-PROOF: the folder changed before the sync: no resume, no saved results for this run/.test(l)).length, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /\[break=/);
  const rec = readRecord(f.repo);
  assert.deepEqual(Object.keys(rec?.perBreak?.[f.keyOf(FULL)] || {}), [], 'no per-break save');
  assert.equal(rec?.runs?.[f.keyOf(FULL)], undefined, 'no run facts');
});

test('a second proof of the same tree resumes a break only when the session log shows it', { skip }, () => {
  const f = fixture();
  const first = f.proof(FULL);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /\[break=[0-9a-f]{16} tree=[0-9a-f]{40,64}\]/);
  // No log: the saved break is refused and printed so.
  const second = f.proof(FULL);
  assert.match(second.stdout, /Resume refused for 1 of 1 breaks: saved for this tree, but no session log was found; sending all 1/);
  // The log of the earlier run holds the line: no refusal. (One break only: nothing is dropped from the plan, all are sent.)
  f.log(first.stdout);
  const third = f.proof(FULL);
  assert.doesNotMatch(third.stdout, /Resume refused/);
});

test('a proof that stops after its passing run keeps the passing-run fact and the caught break (the command does not end well)', { skip: skip || (process.platform === 'win32' && 'the Windows stand-in for ssh always exits 0') }, () => {
  const f = fixture();
  const said = answer(CAUGHT, greenLine());
  const r = f.proof(said, { STANDIN_EXIT: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const code = codeFingerprint(f.repo);
  const rec = readRecord(f.repo);
  assert.equal(rec.runs[f.keyOf(said)][code].green, true, 'saved when its line arrived');
  assert.deepEqual(Object.values(rec.perBreak[f.keyOf(said)]).map(x => x.state), ['caught']);
  // A machine stop (exit 6) takes back what this run saved.
  const g = fixture();
  const stop = g.proof(said, { STANDIN_EXIT: '6' });
  assert.equal(stop.status, 6, stop.stdout + stop.stderr);
  assert.deepEqual(Object.keys(readRecord(g.repo)?.perBreak?.[g.keyOf(said)] || {}), []);
  assert.equal(readRecord(g.repo)?.runs?.[g.keyOf(said)]?.[codeFingerprint(g.repo)], undefined);
});
