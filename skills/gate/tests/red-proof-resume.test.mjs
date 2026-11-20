// 2026-11-19: every break's result was read after all runs had ended, so a stop, a lost link or one run past the
// time limit lost the finished breaks too. Each break is now judged when its own run ends and its result is saved
// at once in the proof record (writeBreakResult), for the exact code tree the run tested. A machine or database
// failure takes back what its run saved. A second start on the same tree runs only the breaks not yet caught there
// (RESUMED k of n breaks from saved results of this tree; --fresh runs all). Local runs only; the remote path still runs every break.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { breakId, breakStates, codeFingerprint, evidenceOf, readRecord, recordKey } from '../scripts/proof-record.mjs';
import { caughtTails } from '../scripts/red-proof.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-resume-'));
const repos = [];
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = fs.mkdtempSync(path.join(root, 'state-'));
// The tests read the record with the same state folder the runs write.
process.env.SANAD_STATE_DIR = state;
// 2026-11-20 (V1): a break is resumed only when an earlier tool result of THIS session's log shows it caught on the same tree.
// The fixtures keep a session log of their own (SANAD_PROJECTS_DIR), and the tests put an earlier run's output into it the
// way the host does: a tool call that names red-proof, then its result.
const projects = fs.mkdtempSync(path.join(root, 'projects-'));
function env(extra = {}) { return { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state, SANAD_PROJECTS_DIR: projects, CLAUDE_CODE_SESSION_ID: '', ...extra }; }
let calls = 0;
function logRun(repo, stdout, command = 'node red-proof.mjs --breaks b.json -- node check.cjs') {
  const folder = path.join(projects, path.resolve(repo).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const id = 'toolu_' + (++calls);
  fs.appendFileSync(path.join(folder, 's1.jsonl'), [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: stdout }] }, toolUseResult: { stdout, stderr: '' } }), ''].join('\n'));
}
const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: env(extra) });
after(() => {
  for (const repo of repos) run(['--repo', repo, '--drop-copies']);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const WORDS = ['one', 'two', 'three', 'four'];
// Four rules, one test each. A rule set to false fails its test; "hang" never ends; "nobuild" is a build error;
// "db" is a database that does not answer; "pass" changes nothing a test sees.
const CHECK = [
  'const fails = [], nl = String.fromCharCode(10); let special = "";',
  'for (const [k, w] of [["r1", "one"], ["r2", "two"], ["r3", "three"], ["r4", "four"]]) {',
  '  const v = require("./" + k + ".cjs").on;',
  '  if (v === false) fails.push(" FAIL  src/a.test.cjs > rules > rule " + w + " holds", "AssertionError: expected false to be true");',
  '  else if (v !== true) special = v;',
  '}',
  'if (process.env.RP_FAIL) { console.log(" FAIL  src/a.test.cjs > rules > rule one holds" + nl + "AssertionError: expected false to be true"); process.exit(1); }',
  'if (special === "hang") setInterval(() => {}, 1000);',
  'else if (special === "nobuild") { console.log("Rule.cs(3,9): error CS1002: ; expected" + nl + "Build FAILED."); process.exit(1); }',
  'else if (special === "db") { console.log("Unable to connect to any of the specified MySQL hosts"); process.exit(1); }',
  'else if (fails.length) { console.log(fails.join(nl)); process.exit(1); }', ''].join('\n');
let n = 0;
// puts: what each break puts in place of `on: true`, by rule (default: false, which its test catches).
function fixture(puts = {}) {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  repos.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: env() }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  for (const k of [1, 2, 3, 4]) fs.writeFileSync(path.join(repo, `r${k}.cjs`), 'module.exports = { on: true };\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), CHECK);
  git('add', '.'); git('commit', '-qm', 'rules');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.test.cjs'), ["describe('rules', () => {", ...WORDS.map(w => `  it('rule ${w} holds', () => {});`), '});', ''].join('\n'));
  const breaks = WORDS.map((w, i) => ({ name: `rule ${w} off`, file: `r${i + 1}.cjs`, find: 'on: true', put: `on: ${JSON.stringify(puts[w] ?? false)}`, mustFail: [`rule ${w} holds`] }));
  const file = path.join(root, `breaks${n}.json`);
  fs.writeFileSync(file, JSON.stringify(breaks));
  const key = recordKey([process.execPath, 'check.cjs'], '');
  const proof = (...extra) => run(['--repo', repo, '--local', '--base', 'HEAD', '--breaks', file, ...extra, '--', process.execPath, 'check.cjs']);
  // The saved state of each break, by its rule's word.
  const saved = () => Object.fromEntries(Object.values(readRecord(repo)?.perBreak?.[key] || {}).map(r => [r.name.split(' ')[1], r.state]));
  const log = (r, command) => logRun(repo, r.stdout, command);
  return { repo, git, breaks, file, key, proof, saved, log };
}

for (const parallel of ['1', '3']) {
  test(`each break's result is saved for the tree it ran on: caught, not caught and a break that does not compile (--parallel ${parallel})`, () => {
    const f = fixture({ three: 'nobuild', four: 'pass' });
    const tree = codeFingerprint(f.repo);
    const r = f.proof('--then-green', '--parallel', parallel);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /BREAK INVALID ✗ rule three off/);
    assert.match(r.stdout, /BREAK ✗ rule four off/);
    assert.match(r.stdout, /RED-PROOF: NOT PROVED ✗/);
    assert.deepEqual(f.saved(), { one: 'caught', two: 'caught', three: 'invalid', four: 'not-caught' });
    const results = Object.values(readRecord(f.repo).perBreak[f.key]);
    assert.ok(results.every(x => x.tree === tree), 'each result names the tree the runs tested');
    assert.deepEqual(results.find(x => x.name === 'rule one off').caught, { 'src/a.test.cjs': [{ line: 2, title: 'rule one holds', ran: 'src/a.test.cjs > rules > rule one holds' }] });
    assert.deepEqual(results.find(x => x.state === 'invalid').caught, {}, 'only a caught break names tests');
    // The record's reader: the two caught breaks are proved on this tree and count (green passed there); the others must run.
    assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => [s.state, s.saved, s.counts]),
      [['proved', 'caught', true], ['proved', 'caught', true], ['run', 'invalid', false], ['run', 'not-caught', false]]);
    // The entry of the whole proof still says not proved.
    assert.equal(Object.values(readRecord(f.repo).entries)[0].ok, false);
    // After a one-byte code edit no saved result is for today's tree: every break must run again.
    fs.appendFileSync(path.join(f.repo, 'r1.cjs'), '\n');
    assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => s.state), ['run', 'run', 'run', 'run']);
  });
}

test('one run past the time limit: that break is saved as timeout, never caught; the finished breaks are kept; NOT PROVED, exit 5', () => {
  const f = fixture({ two: 'hang' });
  // A limit no honest run reaches on a busy machine (30 s); the run that hangs is stopped sooner, as stuck, once two
  // others have finished (never under a fifth of the limit). Either way it is a run that did not finish: a timeout.
  const r = f.proof('--parallel', '4', '--timeout-min', '0.5');
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: TIMEOUT ✗ — break rule two off/);
  assert.match(r.stdout, /RED-PROOF: NOT PROVED ✗ — 1 run\(s\) did not finish/);
  assert.deepEqual(f.saved(), { one: 'caught', two: 'timeout', three: 'caught', four: 'caught' });
  assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => s.state), ['proved', 'run', 'proved', 'proved']);
});

test('a machine or database failure: exit 6, and what this run saved is taken back', () => {
  const f = fixture({ three: 'db' });
  const r = f.proof('--parallel', '1');
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stdout, /RED-PROOF: ENVIRONMENT ✗/);
  assert.deepEqual(f.saved(), {}, 'the results of the runs before the failure are gone');
  assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => s.state), ['run', 'run', 'run', 'run']);
});

test('the result of an earlier proof on the same tree stays when a later run of it fails on the machine', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /RED-PROOF: PROVED ✓ — 4 break\(s\) caught, green on the fix/);
  assert.deepEqual(f.saved(), { one: 'caught', two: 'caught', three: 'caught', four: 'caught' });
  f.log(first);
  // Another break list (one more break, of a database that is down) under the same command.
  const more = [...f.breaks, { name: 'rule db off', file: 'r4.cjs', find: 'on: true', put: 'on: "db"', mustFail: ['rule four holds'] }];
  fs.writeFileSync(f.file, JSON.stringify(more));
  const second = f.proof('--parallel', '1');
  assert.equal(second.status, 6, second.stdout + second.stderr);
  const kept = Object.values(readRecord(f.repo).perBreak[f.key]);
  assert.equal(kept.length, 4, 'the four caught breaks are resumed, not run again: the earlier results stay, and the failed run took back only its own');
});

test('on the test machine (--plan) a caught break says so when its run ends, once, and nothing is stored there', () => {
  const f = fixture({ four: 'pass' });
  f.git('add', '-A'); f.git('commit', '-qm', 'the tests');
  const plan = path.join(root, `plan${n}.json`);
  fs.writeFileSync(plan, JSON.stringify({ breaks: f.breaks, green: true, commit: f.git('rev-parse', 'HEAD'), testFiles: ['src/a.test.cjs'] }));
  const r = run(['--repo', f.repo, '--local', '--plan', plan, '--base', 'HEAD', '--parallel', '2', '--', process.execPath, 'check.cjs']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const lines = r.stdout.split(/\r?\n/);
  const sent = lines.map((l, i) => (/^RED-PROOF-CAUGHT: /.test(l) ? i : -1)).filter(i => i >= 0);
  assert.equal(sent.length, 3, 'one line per caught break, none twice: ' + r.stdout);
  const report = lines.findIndex(l => /^\s*BREAK [✓✗]/.test(l));
  assert.ok(sent.every(i => i < report), 'each line went out when its run ended, before the report at the end');
  assert.equal(readRecord(f.repo), null, 'the test machine stores nothing');
});

test('a second start on the same tree runs only the breaks not yet caught (RESUMED), --fresh runs all, a code edit runs all', () => {
  const f = fixture({ four: 'pass' });
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.doesNotMatch(first.stdout, /RESUMED/);
  f.log(first);
  // Fix the weak break: rule four now fails its test.
  const weak = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  weak[3].put = 'on: false';
  fs.writeFileSync(f.file, JSON.stringify(weak));
  const second = f.proof('--then-green', '--parallel', '2');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /RESUMED 3 of 4 breaks from saved results of this tree/);
  assert.match(second.stdout, /BREAK ✓ rule one off: caught earlier/);
  assert.match(second.stdout, /RED-PROOF: PROVED ✓ — 4 break\(s\) caught, green on the fix/);
  const fresh = f.proof('--then-green', '--parallel', '2', '--fresh');
  assert.doesNotMatch(fresh.stdout, /RESUMED/);
  assert.match(fresh.stdout, /PROVED ✓/);
  fs.appendFileSync(path.join(f.repo, 'r1.cjs'), '\n');
  const edited = f.proof('--then-green', '--parallel', '2');
  assert.doesNotMatch(edited.stdout, /RESUMED/);
});

test('a passing run, then a failing run on the same tree: the earlier pass is withdrawn and no proof counts', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => s.counts), [true, true, true, true]);
  const second = f.proof('--then-green', '--parallel', '2');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const bad = run(['--repo', f.repo, '--local', '--base', 'HEAD', '--breaks', f.file, '--then-green', '--parallel', '2', '--', process.execPath, 'check.cjs'], { RP_FAIL: '1' });
  assert.notEqual(bad.status, 0, bad.stdout + bad.stderr);
  assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => s.counts), [false, false, false, false], 'the saved pass of this tree is gone');
  assert.equal(readRecord(f.repo).runs?.[f.key]?.[codeFingerprint(f.repo)]?.green === true, false);
  const ev = evidenceOf(f.repo, { base: 'HEAD' });
  assert.ok(!ev || ev.every(e => e.evidence === 'none'), 'no proof for the tree');
});

test('resume needs the passing-run fact of the same tree; one clear RESUMED line; --fresh ignores every saved result', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0);
  const rec = (() => { for (const dir of [state, path.join(state, 'proof')]) { try { for (const n of fs.readdirSync(dir)) { if (!/^[0-9a-f]{16}\.json$/.test(n)) continue; try { if (path.resolve(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).top) === path.resolve(f.repo)) return path.join(dir, n); } catch { /* next */ } } } catch { /* next */ } } return null; })();
  assert.ok(rec, 'the record file of this repository is found');
  const json = JSON.parse(fs.readFileSync(rec, 'utf8'));
  delete json.runs;
  fs.writeFileSync(rec, JSON.stringify(json));
  f.log({ stdout: first.stdout });
  const none = f.proof('--then-green', '--parallel', '2');
  assert.doesNotMatch(none.stdout, /RESUMED/, 'a break result with no passing-run fact is not enough');
  assert.match(none.stdout, /PROVED ✓/);
  f.log(none);
  const again = f.proof('--then-green', '--parallel', '2');
  assert.match(again.stdout, /^RESUMED 4 of 4 breaks from saved results of this tree/m);
  const fresh = f.proof('--then-green', '--parallel', '2', '--fresh');
  assert.doesNotMatch(fresh.stdout, /RESUMED/);
  assert.match(fresh.stdout, /RED-PROOF: PROVED ✓ — 4 break\(s\) caught, green on the fix/);
});

// ---- 2026-11-20 (V1): the resume is bound to the session log ----

test('every caught line ends in a fixed tail with the break id and the tree id; its visible start is as before', () => {
  const f = fixture();
  const r = f.proof('--then-green', '--parallel', '2');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const tree = codeFingerprint(f.repo);
  const rows = r.stdout.split(/\r?\n/).filter(l => /^\s*BREAK ✓ /.test(l));
  assert.equal(rows.length, 4);
  f.breaks.forEach((b, i) => assert.ok(rows[i].startsWith(`  BREAK ✓ ${b.name}: all 1 named test(s) fail [break=${breakId(b)} tree=${tree}]`), rows[i]));
  assert.deepEqual(caughtTails(r.stdout).sort(), f.breaks.map(b => breakId(b) + ' ' + tree).sort());
  assert.match(r.stdout, /RED-PROOF: PROVED ✓ — 4 break\(s\) caught, green on the fix; files restored\.$/m);
  // A resumed break's line carries the tail too.
  f.log(r);
  const again = f.proof('--then-green', '--parallel', '2');
  assert.match(again.stdout, /BREAK ✓ rule one off: caught earlier on this exact tree \(saved result, not run again\) \[break=[0-9a-f]{16} tree=[0-9a-f]{40,64}\]/);
});

test('a record with every fact but no session log line resumes nothing: all four run again, and the refusal is printed', () => {
  const f = fixture();
  assert.equal(f.proof('--then-green', '--parallel', '2').status, 0);
  assert.deepEqual(breakStates(f.repo, f.key, f.breaks).map(s => s.counts), [true, true, true, true], 'the record alone would resume all four');
  const again = f.proof('--then-green', '--parallel', '2');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.doesNotMatch(again.stdout, /RESUMED|caught earlier/);
  assert.match(again.stdout, /Resume refused for 4 of 4 breaks: saved for this tree, but no session log was found; running all 4/);
  assert.match(again.stdout, /RED-PROOF: PROVED ✓ — 4 break\(s\) caught, green on the fix/);
});

test('a session line of the same tree resumes the break; the count of resumed and of refused breaks is printed', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // Only two of the four caught lines are in the log: those two are resumed, the other two run and are refused.
  const kept = first.stdout.split(/\r?\n/).filter(l => !/^\s*(?:BREAK ✓ |ran break )rule (three|four) off/.test(l)).join('\n');
  f.log({ stdout: kept });
  const again = f.proof('--then-green', '--parallel', '2');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^RESUMED 2 of 4 breaks from saved results of this tree; running the other 2; 2 more saved for this tree but refused: no earlier line of this session's log shows them caught/m);
  assert.match(again.stdout, /BREAK ✓ rule one off: caught earlier/);
  assert.match(again.stdout, /BREAK ✓ rule three off: all 1 named test\(s\) fail/);
});

test('a session line for another tree resumes nothing', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const tree = codeFingerprint(f.repo);
  f.log({ stdout: first.stdout.split(tree).join('0'.repeat(tree.length)) });
  const again = f.proof('--then-green', '--parallel', '2');
  assert.doesNotMatch(again.stdout, /RESUMED|caught earlier/);
  assert.match(again.stdout, /Resume refused for 4 of 4 breaks: saved for this tree, but no earlier line of this session's log shows them caught; running all 4/);
});

test('a session line for another break (the id changed) resumes nothing', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  f.log({ stdout: first.stdout.replace(/\[break=[0-9a-f]{16} /g, '[break=0000000000000000 ') });
  const again = f.proof('--then-green', '--parallel', '2');
  assert.doesNotMatch(again.stdout, /RESUMED|caught earlier/);
});

test('a line in the result of a command that is not a red-proof run does not count', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  f.log(first, 'echo done');
  const again = f.proof('--then-green', '--parallel', '2');
  assert.doesNotMatch(again.stdout, /RESUMED|caught earlier/);
  assert.match(again.stdout, /Resume refused for 4 of 4/);
});

test('--fresh ignores the log and the record; a session log that cannot be read resumes nothing', () => {
  const f = fixture();
  const first = f.proof('--then-green', '--parallel', '2');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  f.log(first);
  const fresh = f.proof('--then-green', '--parallel', '2', '--fresh');
  assert.doesNotMatch(fresh.stdout, /RESUMED|Resume refused|caught earlier/);
  // The newest "log" is a folder: it cannot be read.
  const folder = path.join(projects, path.resolve(f.repo).replace(/[^A-Za-z0-9]/g, '-'));
  fs.rmSync(path.join(folder, 's1.jsonl'));
  fs.mkdirSync(path.join(folder, 's1.jsonl'));
  const broken = f.proof('--then-green', '--parallel', '2');
  assert.doesNotMatch(broken.stdout, /RESUMED|caught earlier/);
  assert.match(broken.stdout, /Resume refused for 4 of 4 breaks: saved for this tree, but the session log could not be read; running all 4/);
});

test('caughtTails reads the tail of a caught line and nothing else', () => {
  const tree = 'a'.repeat(40), id = 'b'.repeat(16);
  assert.deepEqual(caughtTails(`noise\n  BREAK ✓ x: all 1 named test(s) fail [break=${id} tree=${tree}]\r\n  BREAK ✗ y: still pass [break=${id} tree=${tree}]\n`), [id + ' ' + tree]);
  assert.deepEqual(caughtTails(`  BREAK ✓ x: all 1 named test(s) fail [break=${id} tree=short]`), []);
  assert.deepEqual(caughtTails('  BREAK ✓ x: all 1 named test(s) fail'), []);
});
