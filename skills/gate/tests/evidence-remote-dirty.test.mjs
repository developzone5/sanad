// 2026-11-17 (audit: remote proof accepts tracked source changes during verification). The last look at the
// test machine's clone also read its changed files, and the caller threw them away: only the committed tree
// was compared. A tracked file changed there DURING the run leaves that tree as it was, so the run still gave
// a "passed" receipt for code nobody committed. Changed files there after the check now fail the receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCommand } from '../scripts/evidence.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-remote-dirty-'));
// Best effort: Windows may hold the copied program for a moment after its last run.
test.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left to the temp cleaner */ } });
process.env.SANAD_CHECK_LOCK_DIR = path.join(root, 'locks');
process.env.SANAD_STATE_DIR = path.join(root, 'state');
// Git run by this file and by the fake test machine reads none of this machine's settings. evidence.mjs drops
// GIT_* for its own git calls, so what it reads (line endings, ignore file, test machine) is set in each
// fixture repository as well.
const emptyConfig = path.join(root, 'empty.gitconfig'), emptyIgnore = path.join(root, 'empty-ignore');
fs.writeFileSync(emptyConfig, ''); fs.writeFileSync(emptyIgnore, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const out = path.join(root, 'out');

// A program named "ssh" that we can run: Node itself under that name (a .cmd cannot be started without a shell
// on Windows). It runs the script file below and gets the host and the remote line after it, as ssh would.
const ssh = path.join(root, process.platform === 'win32' ? 'ssh.exe' : 'ssh');
fs.copyFileSync(process.execPath, ssh);
if (process.platform !== 'win32') fs.chmodSync(ssh, 0o755);
const HOST = 'pc2';

// The fake test machine: it runs the remote line's commands in the folder the line names, git with the real
// git. `change <file>` and `pass` stand for the check itself: a run that rewrites a tracked file there, and a
// run that touches nothing. (Never called here: its text goes to a file that Node, as ssh, runs.)
function testMachine() {
  const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
  let cwd = process.cwd();
  for (const part of String(process.argv[3] || '').split('&&').map(p => p.trim())) {
    const cd = /^cd \/d "?(.+?)"?$/.exec(part);
    if (cd) { cwd = cd[1]; continue; }
    const words = part.split(/\s+/);
    // cmd.exe on the real test machine reads ^^ as one ^ (HEAD^^{tree}).
    if (words[0] === 'git') process.stdout.write(execFileSync('git', words.slice(1).map(w => w.replace(/\^\^/g, '^')), { cwd, encoding: 'utf8', windowsHide: true }));
    else if (words[0] === 'write') fs.writeFileSync(path.join(cwd, words[1]), 'x\n');
    else if (words[0] === 'crlf') { const f = path.join(cwd, words[1]); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n')); }
    else if (words[0] === 'change') fs.appendFileSync(path.join(cwd, words[1]), '// changed by the check\n');
    else if (words[0] !== 'pass') process.exit(64);
  }
}
const machine = path.join(root, 'test-machine.cjs');
fs.writeFileSync(machine, `(${testMachine})();\n`);
// The check as a real one is run: ssh, the host, then one line for the test machine's shell.
const remoteLine = (there, command) => [machine, HOST, `cd /d "${there}" && ${command}`];

let cases = 0;
// This folder's repository. With `clone`, the test machine's folder is a real second clone of it at the same
// commit; without, a path that only a stand-in probe is asked about.
function fixture({ clone = false } = {}) {
  const dir = path.join(root, 'case' + (++cases));
  const repo = path.join(dir, 'repo'), there = path.join(dir, 'clone').replace(/\\/g, '/');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Evidence fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false'); git('config', 'core.excludesFile', emptyIgnore);
  git('config', 'sanad.remoteHost', HOST); git('config', 'sanad.remoteRepo', there);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-qm', 'fixture');
  if (clone) git('clone', '-q', '-c', 'core.autocrlf=false', repo, there);
  return { repo, there };
}
const localTree = async repo => (await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out })).source.treeBefore;

test('a tracked file changed on the test machine during the run: a zero exit cannot pass (real git, the real probe)', async () => {
  const { repo, there } = fixture({ clone: true });
  // The same run with nothing changed there passes: the fixture itself is sound.
  const clean = await runCommand({ executable: ssh, args: remoteLine(there, 'pass'), cwd: repo, outputRoot: out });
  assert.equal(clean.status, 'passed', clean.reason);
  assert.equal(clean.remote.treeAfter, clean.source.treeBefore);

  const result = await runCommand({ executable: ssh, args: remoteLine(there, 'change app.js'), cwd: repo, outputRoot: out });
  assert.equal(result.nativeExitCode, 0, 'the check itself ended well');
  assert.equal(result.remote.treeAfter, result.source.treeBefore, 'the committed tree there did not move: the tree check alone sees nothing');
  assert.equal(result.source.treeAfter, result.source.treeBefore, 'this folder did not change either');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /test machine \(pc2\) has uncommitted changes after the check: app\.js\./);
  assert.match(result.reason, /remote-sync\.sh/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, 'metadata.json'), 'utf8')).status, 'failed', 'the saved receipt fails too');
  assert.equal(fs.readdirSync(process.env.SANAD_CHECK_LOCK_DIR).length, 0, 'the lock is released');

  // As before: the next run finds the changed file before it starts, and does not start.
  const next = await runCommand({ executable: ssh, args: remoteLine(there, 'change app.js'), cwd: repo, outputRoot: out });
  assert.equal(next.status, 'failed');
  assert.equal(next.nativeExitCode, null);
  assert.match(next.reason, /changed files/);
});

test('the changed files are named in the reason: the first three, then how many more', async () => {
  const { repo, there } = fixture();
  const tree = await localTree(repo);
  const dirty = [' M Server/Program.cs', 'M  web/src/app.ts', 'R  old name.cs -> new name.cs', ' D gone.cs', 'MM both.cs'].join('\n');
  let calls = 0;
  const result = await runCommand({ executable: ssh, args: remoteLine(there, 'pass'), cwd: repo, outputRoot: out,
    remoteProbe: () => ({ tree, dirty: ++calls === 1 ? '' : dirty }) });
  assert.equal(calls, 2, 'asked once before the command and once after it');
  assert.equal(result.nativeExitCode, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /after the check: Server\/Program\.cs, web\/src\/app\.ts, old name\.cs -> new name\.cs and 2 more\./);
  assert.doesNotMatch(result.reason, /gone\.cs|both\.cs/);
});

test('a secret in a changed file name is masked in the reason', async () => {
  const { repo, there } = fixture();
  const tree = await localTree(repo);
  let calls = 0;
  // (The line has no leading space here: a probe that trims its whole answer gives the first line that way.)
  const result = await runCommand({ executable: ssh, args: remoteLine(there, 'pass'), cwd: repo, outputRoot: out, secrets: ['hunter2-secret'],
    remoteProbe: () => ({ tree, dirty: ++calls === 1 ? '' : 'M notes/hunter2-secret.txt' }) });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /after the check: notes\/\[REDACTED\]\.txt\./);
  assert.doesNotMatch(JSON.stringify(result), /hunter2-secret/);
});

// Not a new rule: both runs below failed before 2026-11-17 too, with these reasons. They pin that the new
// reason is given only to a run that had none: it never takes the place of an older one.
test('changed files there never hide a reason that was given before', async () => {
  const { repo, there } = fixture();
  const tree = await localTree(repo);
  let calls = 0;
  const swapped = await runCommand({ executable: ssh, args: remoteLine(there, 'pass'), cwd: repo, outputRoot: out,
    remoteProbe: () => (++calls === 1 ? { tree, dirty: '' } : { tree: 'e'.repeat(40), dirty: ' M app.js' }) });
  assert.equal(swapped.status, 'failed');
  assert.match(swapped.reason, /changed while the command was running \(another task put its code there\)/);
  assert.doesNotMatch(swapped.reason, /uncommitted/);

  // This folder's own code changed during the run (Node, as ssh, runs the -e script here): that reason leads.
  calls = 0;
  const local = await runCommand({ executable: ssh, args: ['-e', 'require("node:fs").appendFileSync("app.js", "changed")', HOST, `cd /d "${there}" && pass`],
    cwd: repo, outputRoot: out, remoteProbe: () => ({ tree, dirty: ++calls === 1 ? '' : ' M app.js' }) });
  assert.equal(calls, 2);
  assert.equal(local.status, 'failed');
  assert.equal(local.reason, 'Verified source changed while the command was running.');
});

test('a new untracked file written on the test machine during the run cannot pass (real git, the real probe)', async () => {
  const { repo, there } = fixture({ clone: true });
  const result = await runCommand({ executable: ssh, args: remoteLine(there, 'write extra.js'), cwd: repo, outputRoot: out });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /uncommitted changes after the check: extra\.js\./);
});

test('only line endings changed on the test machine (autocrlf clone): the run still passes', async () => {
  const { repo, there } = fixture({ clone: true });
  execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: there, windowsHide: true });
  const result = await runCommand({ executable: ssh, args: remoteLine(there, 'crlf app.js'), cwd: repo, outputRoot: out });
  assert.equal(result.status, 'passed', result.reason);
});

test('a failing command and changed files there: failed, with the changed-files reason', async () => {
  const { repo, there } = fixture();
  const tree = await localTree(repo);
  let calls = 0;
  const result = await runCommand({ executable: ssh, args: remoteLine(there, 'bogus'), cwd: repo, outputRoot: out,
    remoteProbe: () => ({ tree, dirty: ++calls === 1 ? '' : 'M\tapp.js' }) });
  assert.equal(result.nativeExitCode, 64);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /uncommitted changes after the check: app\.js\./);
});
