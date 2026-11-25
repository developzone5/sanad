// 2026-11-12: a check that runs over ssh inside the test machine's one shared clone must be bound to the
// code that clone holds. Before, the receipt was bound to the local folder only: when another task put
// its code on the test machine (before or during the run), the run still "passed" for this folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCommand, remoteTarget } from '../scripts/evidence.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-remote-'));
process.env.SANAD_CHECK_LOCK_DIR = path.join(root, 'locks');
// Best effort: Windows may hold the copied program for a moment after its last run.
test.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left to the temp cleaner */ } });
const emptyIgnore = path.join(root, 'empty-ignore');
fs.writeFileSync(emptyIgnore, '');
// A program named "ssh" that we can run: Node itself under that name. It gets `-e <script>` first, then the
// host and the remote command as the real ssh would.
const ssh = path.join(root, process.platform === 'win32' ? 'ssh.exe' : 'ssh');
fs.copyFileSync(process.execPath, ssh);
if (process.platform !== 'win32') fs.chmodSync(ssh, 0o755);
const REMOTE = 'C:/Users/Tester/source/repos/App';

function fixture({ host = 'pc2', remoteRepo = REMOTE } = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Evidence fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false'); git('config', 'core.excludesFile', emptyIgnore);
  if (host) git('config', 'sanad.remoteHost', host);
  if (remoteRepo) git('config', 'sanad.remoteRepo', remoteRepo);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-qm', 'fixture');
  return { repo, git };
}
// The fake remote command leaves a file behind, so a test can tell whether it ran at all. (No ssh options
// here: Node, standing in for ssh, would read `-o` as an option of its own.)
function remoteRun(marker) {
  return ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, 'pc2',
    `cd /d C:\\Users\\Tester\\source\\repos\\App\\Server && dotnet test`];
}
const localTree = async repo => (await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: root })).source.treeBefore;

test('a run in the test machine clone is recognised; other ssh runs and repositories with no test machine are not', () => {
  const { repo } = fixture();
  const target = remoteTarget(ssh, ['-o', 'BatchMode=yes', 'pc2', 'cd /d C:\\Users\\Tester\\source\\repos\\App\\Server && dotnet test'], repo);
  assert.deepEqual(target, { host: 'pc2', repo: REMOTE, sshArgs: ['-o', 'BatchMode=yes', 'pc2'] });
  assert.equal(remoteTarget(ssh, ['pc2', 'docker ps'], repo), null, 'a command outside the clone is not bound');
  assert.equal(remoteTarget(ssh, ['other-host', `cd /d ${REMOTE} && dotnet test`], repo), null, 'another machine is not the test machine');
  assert.equal(remoteTarget(process.execPath, ['pc2', `cd /d ${REMOTE} && dotnet test`], repo), null, 'only ssh reaches the test machine');
  // (A repository with no sanad.remoteHost of its own may still get one from the user's global settings,
  // so only the per-repository key is tested here.)
  assert.equal(remoteTarget(ssh, ['pc2', `cd /d ${REMOTE} && dotnet test`], fixture({ remoteRepo: '' }).repo), null, 'no clone named: nothing to bind');
});

test('the same code there before and after: the run passes and the receipt records the code on the test machine', async () => {
  const { repo } = fixture();
  const tree = await localTree(repo);
  const marker = path.join(root, 'ran-same');
  const asked = [];
  const result = await runCommand({ executable: ssh, args: remoteRun(marker), cwd: repo, outputRoot: root,
    remoteProbe: target => { asked.push(target); return { tree, dirty: '' }; } });
  assert.equal(result.status, 'passed', result.reason);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(asked.length, 2, 'asked once before the command and once after it');
  assert.deepEqual(result.remote, { host: 'pc2', repo: REMOTE, treeBefore: tree, treeAfter: tree });
});

test('other code on the test machine before the run: the command does not run and the receipt fails', async () => {
  const { repo } = fixture();
  const marker = path.join(root, 'ran-other');
  const result = await runCommand({ executable: ssh, args: remoteRun(marker), cwd: repo, outputRoot: root,
    remoteProbe: () => ({ tree: 'f'.repeat(40), dirty: '' }) });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /test machine holds other code/);
  assert.match(result.reason, /remote-sync\.sh/);
  assert.equal(fs.existsSync(marker), false, 'a run on other code is a wasted run: it must not start');
  assert.equal(fs.readdirSync(process.env.SANAD_CHECK_LOCK_DIR).length, 0, 'the lock is released');
});

test('changed files in the test machine folder before the run refuse it', async () => {
  const { repo } = fixture();
  const tree = await localTree(repo);
  const marker = path.join(root, 'ran-dirty');
  const result = await runCommand({ executable: ssh, args: remoteRun(marker), cwd: repo, outputRoot: root,
    remoteProbe: () => ({ tree, dirty: ' M Server/Program.cs' }) });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /changed files/);
  assert.equal(fs.existsSync(marker), false);
});

test('another task puts its code there during the run: a zero exit cannot pass', async () => {
  const { repo } = fixture();
  const tree = await localTree(repo);
  let calls = 0;
  const result = await runCommand({ executable: ssh, args: remoteRun(path.join(root, 'ran-swapped')), cwd: repo, outputRoot: root,
    remoteProbe: () => ({ tree: ++calls === 1 ? tree : 'e'.repeat(40), dirty: '' }) });
  assert.equal(result.nativeExitCode, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /changed while the command was running/);
  assert.equal(result.remote.treeAfter, 'e'.repeat(40));
});

test('the test machine cannot be asked: the run is not credited', async () => {
  const { repo } = fixture();
  const marker = path.join(root, 'ran-unreachable');
  const before = await runCommand({ executable: ssh, args: remoteRun(marker), cwd: repo, outputRoot: root,
    remoteProbe: () => { throw new Error('ssh: connect to host pc2 port 22: Connection timed out'); } });
  assert.equal(before.status, 'failed');
  assert.match(before.reason, /Cannot read the code on the test machine/);
  assert.equal(fs.existsSync(marker), false);

  const tree = await localTree(repo);
  let calls = 0;
  const after = await runCommand({ executable: ssh, args: remoteRun(marker), cwd: repo, outputRoot: root,
    remoteProbe: () => { if (++calls === 2) throw new Error('lost'); return { tree, dirty: '' }; } });
  assert.equal(after.status, 'failed');
  assert.match(after.reason, /Cannot read the code on the test machine/);
});

// 2026-11-18: the ssh run outside the clone used to PASS here, bound to the local folder only; that is the finding
// "another spelling of the host skips the binding". It now fails before it starts (still not asked about the test machine).
test('a local run passes; an ssh run outside the clone is not asked about the test machine and does not pass', async () => {
  const { repo } = fixture();
  let asked = 0;
  const local = await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: root, remoteProbe: () => { asked++; return { tree: 'x', dirty: '' }; } });
  assert.equal(local.status, 'passed');
  assert.equal(local.remote, undefined);
  const elsewhere = await runCommand({ executable: ssh, args: ['-e', '0', 'pc2', 'docker ps'], cwd: repo, outputRoot: root, remoteProbe: () => { asked++; return { tree: 'x', dirty: '' }; } });
  assert.equal(elsewhere.status, 'failed');
  assert.match(elsewhere.reason, /not bound to the test machine clone/);
  assert.equal(asked, 0);
});

// 2026-11-25 (owner, test 4): a suite on the test machine ran its own Node 26, not the pinned Node 20 (sanad.remoteNode).
// The pinned Node's folder goes first on the path of the remote line; no new refusal; the receipt keeps the spec's command.
test('a suite on the test machine runs with the pinned Node first on its path; the receipt keeps the command as written', async () => {
  const { repo, git } = fixture();
  git('config', 'sanad.remoteNode', 'C:/tools/node-v20/node.exe');
  const tree = await localTree(repo);
  const marker = path.join(root, 'ran-pinned');
  const line = 'cd /d C:\\Users\\Tester\\source\\repos\\App\\web && node node_modules/vitest/vitest.mjs run';
  const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(-2)))`, 'pc2', line];
  const result = await runCommand({ executable: ssh, args, cwd: repo, outputRoot: root, remoteProbe: () => ({ tree, dirty: '' }) });
  assert.equal(result.status, 'passed', result.reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['pc2', 'set "PATH=C:\\tools\\node-v20;%PATH%" && ' + line]);
  assert.equal(result.args.at(-1), line, 'the receipt holds the spec\'s command');
  assert.equal(result.remote.pinnedNodeFirst, true);
});

test('withPinnedNode: a POSIX clone, no pinned folder, and a folder with a shell sign', async () => {
  const { withPinnedNode } = await import('../scripts/evidence.mjs');
  const remote = { host: 'box', repo: '/srv/app', sshArgs: ['box'] };
  assert.deepEqual(withPinnedNode(['box', 'cd /srv/app && npm test'], remote, '/opt/node20/bin/node'), ['box', "PATH='/opt/node20/bin':\"$PATH\"; cd /srv/app && npm test"]);
  const same = ['box', 'cd /srv/app && npm test'];
  assert.equal(withPinnedNode(same, remote, 'node'), same, 'a bare node: nothing to put first');
  const told = [];
  assert.equal(withPinnedNode(same, remote, '/opt/no%de/node', (l) => told.push(l)), same);
  assert.match(told[0], /holds a sign the shell reads/);
});
