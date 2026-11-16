import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRecord } from '../scripts/proof-record.mjs';

// 2026-11-16: in a fix round of a big task every re-proof ran all 48 breaks (about 15 minutes), though each fix
// touched one or two files; four rounds lost about an hour. --changed-since <ref> runs only the breaks the change
// since <ref> can reach, says PARTIAL (never PROVED) and never writes the proof record; the full proof runs once at
// the end.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-changed-since-'));
const repos = [];
test.after(() => {
  for (const repo of repos) spawnSync(process.execPath, [script, '--repo', repo, '--drop-copies'], { windowsHide: true, env: env() });
  fs.rmSync(root, { recursive: true, force: true });
});
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = fs.mkdtempSync(path.join(root, 'state-'));
process.env.SANAD_STATE_DIR = state; // readRecord here reads the record the runs write
function env(extra = {}) { return { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state, ...extra }; }
const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: env(extra) });

const WORDS = ['one', 'two', 'three', 'four'];
const breakOf = (w) => ({ name: `rule ${w} off`, file: `r${WORDS.indexOf(w) + 1}.cjs`, find: 'on: true', put: 'on: false', mustFail: [`rule ${w} holds`] });
let n = 0;
// Rules r1..r3 (r4 only when a test writes it), one test file each (src/<word>.test.cjs), and check.cjs, which fails
// the test of each rule that is off. All committed: nothing differs from HEAD until a test changes a file.
function fixture(words = ['one', 'two', 'three']) {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  repos.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: env() }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  const files = ['check.cjs'];
  for (const r of ['r1', 'r2', 'r3']) { fs.writeFileSync(path.join(repo, r + '.cjs'), 'module.exports = { on: true };\n'); files.push(r + '.cjs'); }
  for (const w of WORDS) { fs.writeFileSync(path.join(repo, `src/${w}.test.cjs`), `describe('rules', () => {\n  it('rule ${w} holds', () => {});\n});\n`); files.push(`src/${w}.test.cjs`); }
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'const fs = require("node:fs"), path = require("node:path");',
    'const fails = [];',
    `${JSON.stringify(WORDS)}.forEach((w, i) => {`,
    '  const file = path.join(__dirname, "r" + (i + 1) + ".cjs");',
    '  if (fs.existsSync(file) && !require(file).on) fails.push(" FAIL  src/" + w + ".test.cjs > rules > rule " + w + " holds", "AssertionError: expected false to be true");',
    '});',
    'if (fails.length) { console.log(fails.join("\\n")); process.exit(1); }', ''].join('\n'));
  git('add', '--', ...files); git('commit', '-qm', 'rules');
  const breaks = path.join(root, `breaks${n}.json`);
  fs.writeFileSync(breaks, JSON.stringify(words.map(breakOf)));
  return { repo, git, breaks };
}
const proof = (f, ...extra) => ['--repo', f.repo, '--base', 'HEAD', '--breaks', f.breaks, '--parallel', '2', ...extra, '--', process.execPath, 'check.cjs'];
const FULL_LATER = 'run the full proof (without --changed-since) once before the final review.';
const runRecords = (repo) => {
  const dir = path.join(state, 'proof', 'runs');
  return (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((r) => r.argv.includes(repo));
};

test('only the breaks whose file changed since the ref run (a tracked change and an untracked file): PARTIAL lines, exit 0', () => {
  const f = fixture(['one', 'two', 'three', 'four']);
  fs.writeFileSync(path.join(f.repo, 'r1.cjs'), 'module.exports = { on: true }; // fixed\n');
  fs.writeFileSync(path.join(f.repo, 'r4.cjs'), 'module.exports = { on: true };\n'); // new, untracked
  const r = run(proof(f, '--changed-since', 'HEAD', '--then-green'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^RED-PROOF: PARTIAL — 2 of 4 break\(s\) changed since HEAD: rule one off, rule four off; the others are not run\.$/m);
  assert.ok(r.stdout.indexOf('RED-PROOF: PARTIAL —') < r.stdout.indexOf(' run(s), '), 'the PARTIAL line comes before any run:\n' + r.stdout);
  assert.match(r.stdout, /RED-PROOF: 3 run\(s\), 2 at a time/, 'two breaks and green');
  assert.match(r.stdout, /ran break rule one off/);
  assert.match(r.stdout, /ran break rule four off/);
  assert.doesNotMatch(r.stdout, /rule two off|rule three off/, 'the unchanged breaks are not run');
  assert.match(r.stdout, /BREAK ✓ rule one off/);
  assert.match(r.stdout, /BREAK ✓ rule four off/);
  assert.match(r.stdout, /GREEN ✓/);
  assert.match(r.stdout, new RegExp(`^RED-PROOF: PARTIAL ✓ — 2 of 4 break\\(s\\) caught, green on the fix; files restored; ${FULL_LATER.replace(/[()]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(r.stdout, /PROVED ✓/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'r1.cjs'), 'utf8'), 'module.exports = { on: true }; // fixed\n', 'files restored');
});

test('a break is kept when a test its mustFail names is in a test file that changed since the ref', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'src/two.test.cjs'), "// checked again\ndescribe('rules', () => {\n  it('rule two holds', () => {});\n});\n");
  const r = run(proof(f, '--changed-since', 'HEAD', '--then-green'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^RED-PROOF: PARTIAL — 1 of 3 break\(s\) changed since HEAD: rule two off; the others are not run\.$/m);
  assert.match(r.stdout, /ran break rule two off/);
  assert.doesNotMatch(r.stdout, /rule one off|rule three off/);
  assert.match(r.stdout, /BREAK ✓ rule two off/);
  assert.match(r.stdout, /^RED-PROOF: PARTIAL ✓ — 1 of 3 break\(s\) caught, green on the fix; files restored; run the full proof/m);
});

test('no break changed since the ref: green still runs and the lines say so; with no green or old code nothing runs, exit 0', () => {
  const f = fixture();
  const g = run(proof(f, '--changed-since', 'HEAD', '--then-green'));
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.match(g.stdout, /^RED-PROOF: PARTIAL — 0 of 3 break\(s\) changed since HEAD; no break is run, only green\.$/m);
  assert.match(g.stdout, /RED-PROOF: 1 run\(s\)/);
  assert.doesNotMatch(g.stdout, /ran break|BREAK /);
  assert.match(g.stdout, /GREEN ✓/);
  assert.match(g.stdout, /^RED-PROOF: PARTIAL ✓ — 0 of 3 break\(s\) run \(none changed since HEAD\), green on the fix; files restored; run the full proof/m);
  const none = run(proof(f, '--changed-since', 'HEAD'));
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /^RED-PROOF: PARTIAL — 0 of 3 break\(s\) changed since HEAD; no break is run\.$/m);
  assert.match(none.stdout, /^RED-PROOF: PARTIAL ✓ — 0 of 3 break\(s\) run \(none changed since HEAD\), and no --old or --then-green run was asked, so nothing ran; run the full proof/m);
  assert.doesNotMatch(none.stdout, / run\(s\)|ran |GREEN|backups/, 'nothing ran');
});

test('a partial run writes no proof record (its run record says partial); the full proof then writes it', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'r1.cjs'), 'module.exports = { on: true }; // fixed\n');
  const p = run(proof(f, '--changed-since', 'HEAD', '--then-green'));
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(readRecord(f.repo), null, 'no proof record after a partial run');
  assert.match(p.stdout, /RED-PROOF: PARTIAL ✓/);
  const [partialRun] = runRecords(f.repo);
  assert.equal(partialRun?.partial, true, 'the run record says partial');
  assert.equal(partialRun.green, 'passed');
  const full = run(proof(f, '--then-green'));
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.match(full.stdout, /RED-PROOF: PROVED ✓ — 3 break\(s\) caught, green on the fix/);
  const entries = Object.values(readRecord(f.repo)?.entries || {});
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].ok, entries[0].breaks], [true, 3]);
  const runs = runRecords(f.repo);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].partial, undefined, 'a full run record has no partial mark');
});

test('a kept break the tests do not catch fails as today: NOT PROVED, exit 1', () => {
  const f = fixture();
  fs.writeFileSync(f.breaks, JSON.stringify([{ ...breakOf('one'), put: 'on: true ' }, breakOf('two'), breakOf('three')]));
  fs.writeFileSync(path.join(f.repo, 'r1.cjs'), 'module.exports = { on: true }; // fixed\n');
  const r = run(proof(f, '--changed-since', 'HEAD'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^RED-PROOF: PARTIAL — 1 of 3 break\(s\) changed since HEAD: rule one off; the others are not run\.$/m);
  assert.match(r.stdout, /BREAK ✗ rule one off: still pass/);
  assert.match(r.stdout, /^RED-PROOF: NOT PROVED ✗ — see the lines above; files restored\.$/m);
  assert.doesNotMatch(r.stdout, /PARTIAL ✓|PROVED ✓/);
});

test('--changed-since without --breaks, without a ref, or with a ref git cannot resolve: exit 2, nothing runs', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'r1.cjs'), 'module.exports = { on: true }; // fixed\n');
  const ran = /backups in|ran |run\(s\)|BREAK|GREEN|RED ✓/;
  const single = run(['--repo', f.repo, '--changed-since', 'HEAD', '--break', 'r1.cjs', '--find', 'on: true', '--put', 'on: false', '--', process.execPath, 'check.cjs']);
  assert.equal(single.status, 2, single.stdout + single.stderr);
  assert.match(single.stdout, /RED-PROOF: --changed-since needs --breaks: it picks which of those breaks run again\. Nothing ran\./);
  assert.doesNotMatch(single.stdout, ran);
  const noRef = run(['--repo', f.repo, '--base', 'HEAD', '--breaks', f.breaks, '--changed-since', '--', process.execPath, 'check.cjs']);
  assert.equal(noRef.status, 2, noRef.stdout + noRef.stderr);
  assert.match(noRef.stdout, /RED-PROOF: --changed-since needs a git ref/);
  assert.doesNotMatch(noRef.stdout, ran);
  const unknown = run(proof(f, '--changed-since', 'no-such-ref', '--then-green'));
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout, /RED-PROOF: unknown --changed-since ref no-such-ref; nothing ran\./);
  assert.doesNotMatch(unknown.stdout, ran);
  assert.equal(fs.readFileSync(path.join(f.repo, 'r1.cjs'), 'utf8'), 'module.exports = { on: true }; // fixed\n', 'files untouched');
});

test('keptSince: a break path matches in any case on Windows only, with backslashes or a leading ./', async () => {
  const { keptSince } = await import('../scripts/red-proof.mjs');
  const b = [{ name: 'a', file: '.\\Src\\R1.cjs', mustFail: ['x'] }, { name: 'b', file: 'src/r2.cjs', mustFail: ['y'] }];
  const none = () => '';
  assert.deepEqual(keptSince(b, ['src/r1.cjs'], none, 'win32').map((x) => x.name), ['a']);
  assert.deepEqual(keptSince(b, ['src/r1.cjs'], none, 'linux').map((x) => x.name), []);
  assert.deepEqual(keptSince(b, ['src/r2.cjs', 'docs/x.md'], none, 'linux').map((x) => x.name), ['b']);
});

// The test machine: stand-in scripts in a home folder, and ssh/scp that cannot start, so the plan stays on disk.
function remoteSetup(f) {
  for (const [k, v] of [['sanad.remoteHost', 'pc-test'], ['sanad.remoteRepo', 'C:/r/repo']]) f.git('config', k, v);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const dir = path.join(home, '.claude', 'scripts', 'remote');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'remote-sync.sh'), '#!/usr/bin/env bash\necho "SYNCED pc-test $(git rev-parse HEAD) tree $(git rev-parse \'HEAD^{tree}\')"\n');
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  for (const name of ['ssh', 'scp']) {
    // An empty .com file is found on PATH before ssh.exe and cannot start (EFTYPE); elsewhere a script that fails.
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, name + '.com'), '');
    else { fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(bin, name), 0o755); }
  }
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
  const extra = { HOME: home, USERPROFILE: home };
  const set = (name, value) => { for (const k of Object.keys(process.env)) if (k.toUpperCase() === name && k !== name) extra[k] = value; extra[name] = value; };
  set('TEMP', tmp); set('TMP', tmp); set('TMPDIR', tmp);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  extra[pathKey] = bin + path.delimiter + process.env[pathKey];
  const plans = () => fs.readdirSync(tmp).filter((d) => d.startsWith('sanad-proof-'))
    .flatMap((d) => fs.readdirSync(path.join(tmp, d)).filter((p) => /^plan-.*\.json$/.test(p)).map((p) => JSON.parse(fs.readFileSync(path.join(tmp, d, p), 'utf8'))));
  return { extra, plans };
}

test('on the test machine only the kept breaks are sent: the list is cut before the plan is built, with the same PARTIAL line', () => {
  const f = fixture();
  const remote = remoteSetup(f);
  fs.writeFileSync(path.join(f.repo, 'r2.cjs'), 'module.exports = { on: true }; // fixed\n');
  const r = run(['--repo', f.repo, '--base', 'HEAD', '--breaks', f.breaks, '--changed-since', 'HEAD', '--then-green', '--', 'node', 'check.cjs'], remote.extra);
  assert.equal(r.status, 2, 'the stand-in scp fails: ' + r.stdout + r.stderr);
  assert.match(r.stdout, /could not copy the proof to the test machine/);
  const plans = remote.plans();
  assert.equal(plans.length, 1, r.stdout);
  assert.deepEqual(plans[0].breaks.map((b) => b.name), ['rule two off']);
  assert.deepEqual(plans[0].partial, { ref: 'HEAD', of: 3 });
  assert.equal(plans[0].green, true);
  assert.match(r.stdout, /^RED-PROOF: PARTIAL — 1 of 3 break\(s\) changed since HEAD: rule two off; the others are not run\.$/m);
  assert.ok(r.stdout.indexOf('RED-PROOF: PARTIAL —') < r.stdout.indexOf('RED-PROOF: on pc-test'), 'said before anything is sent:\n' + r.stdout);
});

test('the test machine runs a plan marked partial: PARTIAL ✓, never PROVED; a plan with no kept break and green runs green', () => {
  const f = fixture();
  const commit = f.git('rev-parse', 'HEAD');
  const plan = path.join(root, `plan${n}.json`);
  const local = (body) => { fs.writeFileSync(plan, JSON.stringify({ green: true, commit, testFiles: [], partial: { ref: 'abc123', of: 3 }, ...body }));
    return run(['--repo', f.repo, '--local', '--plan', plan, '--base', 'HEAD', '--parallel', '2', '--', process.execPath, 'check.cjs']); };
  const one = local({ breaks: [breakOf('one')] });
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.match(one.stdout, /BREAK ✓ rule one off/);
  assert.match(one.stdout, /^RED-PROOF: PARTIAL ✓ — 1 of 3 break\(s\) caught, green on the fix; files restored; run the full proof/m);
  assert.doesNotMatch(one.stdout, /PROVED ✓|RED-PROOF: PARTIAL —/, 'no PROVED; the PARTIAL line before the runs is said by the machine that asked');
  const none = local({ breaks: [] });
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /GREEN ✓/);
  assert.match(none.stdout, /^RED-PROOF: PARTIAL ✓ — 0 of 3 break\(s\) run \(none changed since abc123\), green on the fix/m);
});
