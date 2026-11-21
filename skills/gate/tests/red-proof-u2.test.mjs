// 2026-11-20 (U2): red-on-old facts that survive a passing run are tested in proof-record-breaks.test.mjs. Here: two classes
// with one method name, a test name that ends in parentheses, which tool call allows a resume, and the tail on the run line.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { breakId, codeFingerprint } from '../scripts/proof-record.mjs';
import { caughtTails, markNewTests, redOldTests, runsRedProof, sessionCaught } from '../scripts/red-proof.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-u2-'));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = fs.mkdtempSync(path.join(root, 'state-'));
const projects = fs.mkdtempSync(path.join(root, 'projects-'));
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state, SANAD_PROJECTS_DIR: projects, CLAUDE_CODE_SESSION_ID: '' };
process.env.SANAD_STATE_DIR = state;
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const repos = [];
after(() => {
  for (const repo of repos) spawnSync(process.execPath, [script, '--repo', repo, '--drop-copies'], { windowsHide: true, env: baseEnv, timeout: 60000 });
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('U2-2: two classes with one method name: each failing name credits the test of its own class', () => {
  const cs = ['namespace App.Tests;', 'public class AClass {', '  [Fact]', '  public void Works() { }', '}', 'public class BClass {', '  [Fact]', '  public void Works() { }', '}', ''].join(NL);
  const tests = markNewTests(cs, null, 'Tests/Things.cs');
  assert.equal(tests.length, 2);
  assert.deepEqual(Object.keys(tests[0]).sort(), ['file', 'isNew', 'line', 'titles'], 'the class rides on the item without showing in its fields');
  const names = ['App.Tests.AClass.Works', 'App.Tests.BClass.Works'];
  assert.deepEqual(redOldTests(tests, names).map(t => t.line).sort(), tests.map(t => t.line).sort(), 'both failed: both get credit');
  assert.deepEqual(redOldTests(tests, [names[0]]).map(t => t.line), [tests[0].line], 'only the A test failed');
  assert.deepEqual(redOldTests(tests, [names[1] + '(quantity: 2)']).map(t => t.line), [tests[1].line], 'a parameterized name is cut, then the class is read');
  // A name that carries no class cannot tell them apart: neither is credited.
  assert.deepEqual(redOldTests(tests, ['Works']), []);
  assert.deepEqual(redOldTests(tests, ['App.Tests.OtherClass.Works']), []);
});

test('U2-2: a suite path tells two same-titled tests of one file apart', () => {
  const a = { file: 'a.test.js', line: 1, titles: ['one', 'works'] }, b = { file: 'a.test.js', line: 5, titles: ['two', 'works'] };
  assert.deepEqual(redOldTests([a, b], ['a.test.js > one > works']).map(t => t.line), [1]);
  assert.deepEqual(redOldTests([a, b], ['a.test.js > two > works', 'a.test.js > one > works']).map(t => t.line), [1, 5]);
  assert.deepEqual(redOldTests([a, b], ['a.test.js works']), []);
});

test('U2-3: a test whose name ends in parentheses keeps its evidence; an argument list is cut only when the exact name fits no test', () => {
  const price = { file: 'p.test.js', line: 3, titles: ['prices', 'rounds the price (USD)'] };
  assert.deepEqual(redOldTests([price], ['rounds the price (USD)']).map(t => t.title), ['rounds the price (USD)']);
  assert.deepEqual(redOldTests([price], ['p.test.js > prices > rounds the price (USD)']).map(t => t.title), ['rounds the price (USD)']);
  assert.deepEqual(redOldTests([price], ['prices::rounds the price (USD)']).map(t => t.title), ['rounds the price (USD)']);
  // A test with the bare name and a failing name that carries arguments: the cut still works.
  const bare = { file: 'C.cs', line: 3, titles: ['RendersTotal'] };
  assert.deepEqual(redOldTests([bare], ['App.RendersTotal(quantity: 2)']).map(t => t.title), ['RendersTotal']);
  assert.deepEqual(redOldTests([price], ['rounds the price (EUR)']), []);
});

test('U2-4: only a tool call that RUNS red-proof.mjs allows a resume', () => {
  const yes = ['node red-proof.mjs --old x', 'node "C:/a b/scripts/red-proof.mjs" --breaks f.json', 'cd r && node --no-warnings C:' + BS + 'x' + BS + 'red-proof.mjs a',
    '& "C:' + BS + 'Program Files' + BS + 'nodejs' + BS + 'node.exe" .' + BS + 'red-proof.mjs', 'FOO=1 timeout 600 node scripts/red-proof.mjs', 'echo hi' + NL + 'node red-proof.mjs', 'node red-proof.mjs # note'];
  const no = ['cat old-proof.log # red-proof.mjs', 'echo "node red-proof.mjs"', 'grep x red-proof.mjs', 'Get-Content red-proof.mjs | node x.js', 'node x.js red-proof.mjs', 'type red-proof.mjs', "echo 'node red-proof.mjs'", ''];
  for (const c of yes) assert.equal(runsRedProof(c), true, c);
  for (const c of no) assert.equal(runsRedProof(c), false, c);
});

test('U2-4: sessionCaught takes a caught line from a run of the script only, and only beside a RED-PROOF: line', async () => {
  const repo = path.join(root, 'logrepo');
  fs.mkdirSync(repo);
  const folder = path.join(projects, path.resolve(repo).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const id = 'a'.repeat(16), tree = 'b'.repeat(40);
  const caught = `  BREAK ✓ x: all 1 named test(s) fail [break=${id} tree=${tree}]`;
  let n = 0;
  const logRun = (command, stdout) => {
    const tid = 'toolu_' + (++n);
    fs.appendFileSync(path.join(folder, 's1.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: stdout }] }, toolUseResult: { stdout, stderr: '' } }), ''].join(NL));
  };
  const was = process.env.SANAD_PROJECTS_DIR, wasId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.SANAD_PROJECTS_DIR = projects; process.env.CLAUDE_CODE_SESSION_ID = '';
  try {
    logRun('cat old-proof.log # red-proof.mjs', caught + NL + 'RED-PROOF: PROVED');
    assert.equal((await sessionCaught(repo)).keys.size, 0, 'a cat that only mentions the script gives no resume');
    logRun('node red-proof.mjs --breaks b.json -- node check.cjs', caught);
    assert.equal((await sessionCaught(repo)).keys.size, 0, 'a result with no RED-PROOF: line of the run gives no resume');
    logRun('node red-proof.mjs --breaks b.json -- node check.cjs', caught + NL + 'RED-PROOF: NOT PROVED');
    assert.deepEqual([...(await sessionCaught(repo)).keys], [id + ' ' + tree]);
  } finally {
    if (was === undefined) delete process.env.SANAD_PROJECTS_DIR; else process.env.SANAD_PROJECTS_DIR = was;
    if (wasId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = wasId;
  }
});

test('U2-5: the run line of a caught break carries the tail; a proof killed after two caught breaks has left two tails', async () => {
  const repo = path.join(root, 'killrepo');
  fs.mkdirSync(repo);
  repos.push(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, env: baseEnv }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  for (const k of [1, 2, 3]) fs.writeFileSync(path.join(repo, `r${k}.cjs`), 'module.exports = { on: true };' + NL);
  // A false rule fails its test; the third rule, when off, makes the check run on for a long time (it ends by itself).
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const nl = String.fromCharCode(10), fails = [];',
    'for (const [k, w] of [["r1", "one"], ["r2", "two"]]) if (require("./" + k + ".cjs").on === false) fails.push(" FAIL  src/a.test.cjs > rules > rule " + w + " holds" + nl + "AssertionError: expected false to be true");',
    'if (require("./r3.cjs").on === false) setTimeout(() => {}, 25000);',
    'else if (fails.length) { console.log(fails.join(nl)); process.exit(1); }', ''].join(NL));
  git('add', '.'); git('commit', '-qm', 'rules');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.test.cjs'), ["describe('rules', () => {", ...['one', 'two', 'three'].map(w => `  it('rule ${w} holds', () => {});`), '});', ''].join(NL));
  const breaks = ['one', 'two', 'three'].map((w, i) => ({ name: `rule ${w} off`, file: `r${i + 1}.cjs`, find: 'on: true', put: 'on: false', mustFail: [`rule ${w} holds`] }));
  const file = path.join(root, 'breaks-u2.json');
  fs.writeFileSync(file, JSON.stringify(breaks));
  const tree = codeFingerprint(repo);
  const child = spawn(process.execPath, [script, '--repo', repo, '--local', '--base', 'HEAD', '--breaks', file, '--parallel', '1', '--', process.execPath, 'check.cjs'], { windowsHide: true, env: baseEnv });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const ended = new Promise(r => child.on('close', r));
  const started = Date.now();
  while (caughtTails(out).length < 2 && Date.now() - started < 100000) await new Promise(r => setTimeout(r, 200));
  child.kill();
  await Promise.race([ended, new Promise(r => setTimeout(r, 5000))]);
  const wanted = breaks.slice(0, 2).map(b => breakId(b) + ' ' + tree).sort();
  assert.deepEqual(caughtTails(out).sort(), wanted, out);
  assert.match(out, /^ {2}ran break rule (one|two) off: caught \[break=[0-9a-f]{16} tree=[0-9a-f]{40,64}\]$/m, 'the tail sits at the end of the run line');
  assert.doesNotMatch(out, /RED-PROOF: (PROVED|NOT PROVED)/, 'the end report was never printed');
});
