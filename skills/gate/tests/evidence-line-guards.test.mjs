// 2026-11-18 (audit of the receipt promise: "a failed, cut-short, piped or wrong-folder run never yields a passing
// receipt"). The tool judged a run by its exit code and the code tree alone, and never looked at the shell line it
// ran. Each test below starts with the input of the finding (it passed before), then pins the nearest normal flow
// that must keep passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCommand, remoteTarget, redact, rerunSuggestion } from '../scripts/evidence.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-guards-'));
process.env.SANAD_CHECK_LOCK_DIR = path.join(root, 'locks');
test.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left to the temp cleaner */ } });
const emptyIgnore = path.join(root, 'empty-ignore');
fs.writeFileSync(emptyIgnore, '');
const out = path.join(root, 'out');
// Programs we can run under another name: Node itself.
const copyAs = name => {
  const file = path.join(root, process.platform === 'win32' ? name + '.exe' : name);
  fs.copyFileSync(process.execPath, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
};
const ssh = copyAs('ssh');
const THERE = 'C:/Users/Tester/source/repos/App';
const WIN_THERE = THERE.replace(/\//g, '\\');

function fixture({ host = 'pc2', remoteRepo = THERE } = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Evidence fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false'); git('config', 'core.excludesFile', emptyIgnore);
  if (host) git('config', 'sanad.remoteHost', host);
  if (remoteRepo) git('config', 'sanad.remoteRepo', remoteRepo);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-qm', 'fixture');
  return { repo, git };
}
const treeOf = async repo => (await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out })).source.treeBefore;
// The ssh stand-in leaves a marker when it runs; the host and the remote line come after its `-e` script, as for ssh.
let markers = 0;
const marked = () => { const marker = path.join(root, 'marker-' + (++markers)); return { marker, script: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` }; };
const sameTreeProbe = tree => () => ({ tree, dirty: '' });
async function remoteRun(repo, host, line, probe) {
  const { marker, script } = marked();
  const result = await runCommand({ executable: ssh, args: ['-e', script, host, line], cwd: repo, outputRoot: out, remoteProbe: probe });
  return { result, ran: fs.existsSync(marker) };
}

// ---- finding 1: a pipe, `||`, `&` or `;` hides a failed command ----------------------------------------------
test('a pipe, "||", "&" or ";" in the remote line fails the receipt before the command starts', async () => {
  const { repo } = fixture();
  const probe = sameTreeProbe(await treeOf(repo));
  for (const tail of ['| findstr /v zzzz', '& echo done', '|| echo done', '; echo done', '\n echo done']) {
    const { result, ran } = await remoteRun(repo, 'pc2', `cd /d ${WIN_THERE} && node node_modules\\vitest\\vitest.mjs run ${tail}`, probe);
    assert.equal(result.status, 'failed', tail);
    assert.match(result.reason, /outside quotes/, tail);
    assert.equal(result.nativeExitCode, null);
    assert.equal(ran, false, 'the command must not start: ' + tail);
  }
});

test('must not change: "&&", a stream merge and an operator inside quotes still pass', async () => {
  const { repo } = fixture();
  const probe = sameTreeProbe(await treeOf(repo));
  for (const line of [`cd /d ${WIN_THERE} && cd Server && node -v 2>&1`, `cd /d "${WIN_THERE}" && node -e "a|b;c&d" >nul 2>&1`, `cd /d ${WIN_THERE} && node -v 1>&2`]) {
    const { result, ran } = await remoteRun(repo, 'pc2', line, probe);
    assert.equal(result.status, 'passed', line + ' -> ' + result.reason);
    assert.equal(ran, true);
  }
});

test('cmd /c, bash -c and sh -c lines with a pipe fail; a plain "&&" line is not refused', async () => {
  const { repo } = fixture();
  const cmd = copyAs('cmd'), bash = copyAs('bash'), sh = copyAs('sh');
  const refused = async (executable, args) => runCommand({ executable, args, cwd: repo, outputRoot: out });
  for (const [executable, args] of [[cmd, ['/d', '/s', '/c', 'node fail.js | findstr /v zzzz']], [cmd, ['/c', 'node fail.js & echo done']],
    [bash, ['-c', 'node fail.js | tail -n 5']], [sh, ['-lc', 'node fail.js; echo done']], [bash, ['-c', 'node fail.js || true']]]) {
    const result = await refused(executable, args);
    assert.equal(result.status, 'failed', args.join(' '));
    assert.match(result.reason, /outside quotes/);
    assert.equal(result.nativeExitCode, null, 'it must not run');
  }
  // Not refused for its line: the stand-in program is started (and fails by itself, being Node asked to check a file).
  const started = await refused(bash, ['-c', 'echo "a|b" && echo \'c;d\' 2>&1']);
  assert.doesNotMatch(String(started.reason), /outside quotes/);
});

// ---- finding 2: another spelling of the test machine skipped the binding ------------------------------------------
test('the host of an ssh run is the test machine in any case and with a user@; an unbound ssh run fails', async () => {
  const { repo } = fixture({ host: 'DESKTOP-PC2' });
  const line = `cd /d ${WIN_THERE} && node -v`;
  for (const host of ['DESKTOP-PC2', 'desktop-pc2', 'tester@DESKTOP-PC2']) {
    assert.deepEqual(remoteTarget(ssh, ['-o', 'BatchMode=yes', host, line], repo)?.repo, THERE, host);
    // The clone holds OTHER code: a run on any spelling must stop, not pass as a local run.
    const { result, ran } = await remoteRun(repo, host, line, () => ({ tree: 'f'.repeat(40), dirty: '' }));
    assert.equal(result.status, 'failed', host);
    assert.match(result.reason, /test machine holds other code/, host);
    assert.equal(ran, false);
  }
  // An address that is not the configured name cannot be known to be the same machine: not bound, so not credited.
  const ip = await remoteRun(repo, '192.168.1.20', line, sameTreeProbe(await treeOf(repo)));
  assert.equal(ip.result.status, 'failed');
  assert.match(ip.result.reason, /not bound to the test machine clone/);
  assert.equal(ip.ran, false);
  // Inside another shell line it is not bound either.
  const bash = copyAs('bash');
  const wrapped = await runCommand({ executable: bash, args: ['-c', `ssh DESKTOP-PC2 "${line}"`], cwd: repo, outputRoot: out });
  assert.equal(wrapped.status, 'failed');
  assert.match(wrapped.reason, /ssh inside another shell line/);
});

test('must not change: the exact host spelling, with options, still binds and passes', async () => {
  const { repo } = fixture({ host: 'pc2' });
  const tree = await treeOf(repo);
  const { result } = await remoteRun(repo, 'pc2', `cd /d ${WIN_THERE}\\Server && node -v`, sameTreeProbe(tree));
  assert.equal(result.status, 'passed', result.reason);
  assert.deepEqual(result.remote, { host: 'pc2', repo: THERE, treeBefore: tree, treeAfter: tree });
});

// ---- finding 3: the clone folder was matched as a piece of text --------------------------------------------------
test('a sibling folder that starts like the clone, a later cd, or a mere mention of the clone path is not the clone', async () => {
  const { repo } = fixture();
  assert.equal(remoteTarget(ssh, ['pc2', `cd /d ${WIN_THERE}-old && node -v`], repo), null);
  assert.equal(remoteTarget(ssh, ['pc2', `cd /d ${WIN_THERE}-old && node check.js --note ${WIN_THERE}`], repo), null);
  assert.equal(remoteTarget(ssh, ['pc2', `cd /d ${WIN_THERE} && cd /d C:\\other && node -v`], repo), null);
  assert.equal(remoteTarget(ssh, ['pc2', `cd /d ${WIN_THERE} && pushd C:\\other && node -v`], repo), null);
  assert.equal(remoteTarget(ssh, ['pc2', `node ${WIN_THERE}\\check.js`], repo), null);
  assert.equal(remoteTarget(ssh, ['pc2', `cd /d ${WIN_THERE} && cd .. && node -v`], repo), null, 'a relative cd out of the clone');
  const probe = sameTreeProbe(await treeOf(repo));
  const { result, ran } = await remoteRun(repo, 'pc2', `cd /d ${WIN_THERE}-old && node -v`, probe);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /not bound to the test machine clone/);
  assert.equal(ran, false);
});

test('must not change: the clone itself, a folder inside it, a quoted path, a slash at the end and any letter case are the clone', async () => {
  const { repo } = fixture();
  for (const line of [`cd /d ${WIN_THERE}`, `cd /d ${WIN_THERE}\\`, `cd /d "${WIN_THERE}\\EduQuest"`, `cd /d ${WIN_THERE.toUpperCase()}\\web`, `cd /d C:\\x && cd /d ${WIN_THERE} && cd web`, `cd ${WIN_THERE}/Server`]) {
    assert.ok(remoteTarget(ssh, ['pc2', line + ' && node -v'], repo), line);
  }
});

// ---- finding 4: a path into another checkout --------------------------------------------------------------------
test('a path argument inside another Git work tree fails the receipt; a path in this one, node_modules and no path pass', async () => {
  const a = fixture().repo, b = fixture().repo;
  const run = (...args) => runCommand({ executable: process.execPath, args: ['-e', '0', '--', ...args], cwd: a, outputRoot: out });
  for (const args of [['--root', b], [`--root=${b}`], [path.join(b, 'Tests', 'Tests.csproj')], ['--prefix', path.join(b, 'web')], [path.relative(a, b)]]) {
    const result = await run(...args);
    assert.equal(result.status, 'failed', args.join(' '));
    assert.match(result.reason, /another Git work tree/);
    assert.equal(result.nativeExitCode, null);
  }
  for (const args of [[], ['--root', a], [path.join(a, 'not-there-yet', 'x.csproj')], [path.join(b, 'node_modules', 'vitest', 'vitest.mjs')], ['--grep', 'a b', '/d']]) {
    const result = await run(...args);
    assert.equal(result.status, 'passed', args.join(' ') + ' -> ' + result.reason);
  }
});

// 2026-11-18: a relative path into a nested Git repository is judged like the absolute form.
test('a plain relative path into a nested repository fails the receipt; plain relative paths in this repository pass', async () => {
  const { repo, git } = fixture();
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(path.join(nested, 'sub'), { recursive: true });
  const ng = (...args) => execFileSync('git', args, { cwd: nested, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ng('init', '-q'); ng('config', 'user.name', 'N'); ng('config', 'user.email', 'n@example.invalid');
  fs.writeFileSync(path.join(nested, 'unit.test.cjs'), '');
  fs.writeFileSync(path.join(nested, 'sub', 'x.js'), '');
  ng('add', '.'); ng('commit', '-qm', 'n');
  const run = (cwd, ...args) => runCommand({ executable: process.execPath, args: ['-e', '0', '--', ...args], cwd, outputRoot: out });
  for (const [cwd, ...args] of [[repo, 'nested/unit.test.cjs'], [repo, './nested/sub/x.js'], [repo, '--file=nested/unit.test.cjs'], [repo, 'nested'], [repo, '--root', 'nested\\sub\\x.js']]) {
    const result = await run(cwd, ...args);
    assert.equal(result.status, 'failed', args.join(' '));
    assert.match(result.reason, /another Git work tree/);
    assert.equal(result.nativeExitCode, null);
  }
  // must not change: paths and plain words inside this repository, and a path from inside the nested repository itself
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.test.js'), '');
  for (const [cwd, ...args] of [[repo, 'src/a.test.js'], [repo, 'app.js'], [repo, 'src', '--grep', 'works well'], [path.join(repo, 'src'), 'a.test.js', '../app.js'], [repo, 'not-there/yet.js']]) {
    const result = await run(cwd, ...args);
    assert.equal(result.status, 'passed', args.join(' ') + ' -> ' + result.reason);
  }
});

// ---- finding 5: --no-build tests an old build --------------------------------------------------------------------
test('--no-build alone fails the receipt; the same line with a build of the same project before it passes', async () => {
  const { repo } = fixture();
  const dotnet = copyAs('dotnet');
  const alone = await runCommand({ executable: dotnet, args: ['test', 'App.sln', '--no-build'], cwd: repo, outputRoot: out });
  assert.equal(alone.status, 'failed');
  assert.match(alone.reason, /skips the build \(--no-build\)/);
  assert.equal(alone.nativeExitCode, null);
  const probe = sameTreeProbe(await treeOf(repo));
  const refused = line => remoteRun(repo, 'pc2', `cd /d ${WIN_THERE} && ${line}`, probe);
  assert.equal((await refused('dotnet test App.sln --no-build')).result.status, 'failed');
  assert.match((await refused('dotnet build Other.sln && dotnet test App.sln --no-build')).result.reason, /skips the build/);
  assert.match((await refused('dotnet test App.sln --no-build && dotnet build App.sln')).result.reason, /skips the build/, 'the build must come first');
  // A build of the same project earlier in the line, and a --no-build that is not dotnet's, are fine ("node -v" stands in for them).
  const { lineProblem } = await import('../scripts/evidence.mjs');
  const same = ['-e', '0', 'pc2', `cd /d ${WIN_THERE} && dotnet build App.sln --no-restore && dotnet test App.sln --no-build -v q`];
  assert.equal(lineProblem(ssh, same, repo, { toplevel: repo }, remoteTarget(ssh, same, repo)), null);
  const docker = ['-e', '0', 'pc2', `cd /d ${WIN_THERE} && docker compose up -d --no-build app`];
  assert.equal(lineProblem(ssh, docker, repo, { toplevel: repo }, remoteTarget(ssh, docker, repo)), null);
  const plain = await runCommand({ executable: dotnet, args: ['-e', '0'], cwd: repo, outputRoot: out });
  assert.doesNotMatch(String(plain.reason), /skips the build/);
});

// ---- finding 6: a test in a __tests__ folder is named after its source file --------------------------------------
test('a timeout in src/api/__tests__/exams.test.ts is not offered a longer-timeout rerun when src/api/exams.ts changed', async () => {
  const repo = fs.mkdtempSync(path.join(root, 'task-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.excludesFile', emptyIgnore);
  const files = { 'web/src/api/exams.ts': 'export {};\n', 'web/src/api/__tests__/exams.test.ts': 'it("x")\n', 'web/src/api/near.ts': 'export {};\n', 'web/src/api/near.test.ts': 'it("x")\n', 'web/src/api/other.ts': 'export {};\n' };
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); }
  git('add', 'web'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  const web = path.join(repo, 'web');
  const timeout = file => ({ out: [' ❯ ' + file + ' (12 tests | 1 failed) 5123ms', ' Test Files  1 failed | 111 passed (112)', '      Tests  1 failed | 1758 passed (1759)'].join('\n') + '\n',
    err: ['', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯', '', ` FAIL  ${file} > it > slow`, 'Error: Test timed out in 5000ms.', ' ❯ ' + file + ':4:3', '', '⎯⎯⎯[1/1]⎯', ''].join('\n') });
  const ask = async file => {
    const logs = fs.mkdtempSync(path.join(root, 'logs-')), t = timeout(file);
    fs.writeFileSync(path.join(logs, 'stdout.log'), t.out); fs.writeFileSync(path.join(logs, 'stderr.log'), t.err);
    return rerunSuggestion({ receipt: { status: 'failed', nativeExitCode: 1, signal: null, reason: null, stdout: path.join(logs, 'stdout.log'), stderr: path.join(logs, 'stderr.log'), source: { toplevel: fs.realpathSync.native(repo) } },
      spec: { executable: process.execPath, args: ['node_modules/vitest/vitest.mjs', 'run'], cwd: web, outputRoot: root }, specArg: 'C:/checks/frontend-full.json', script: 'C:/u/.claude/skills/gate/scripts/evidence.mjs' });
  };
  fs.appendFileSync(path.join(web, 'src/api/other.ts'), '// the task\n');
  assert.ok(await ask('src/api/__tests__/exams.test.ts'), 'nothing it is named after changed: offered');
  fs.appendFileSync(path.join(web, 'src/api/exams.ts'), '// slower now\n');
  assert.equal(await ask('src/api/__tests__/exams.test.ts'), null, 'its source file changed');
  fs.appendFileSync(path.join(web, 'src/api/near.ts'), '// slower now\n');
  assert.equal(await ask('src/api/near.test.ts'), null, 'the beside-file form still holds');
  assert.ok(await ask('src/api/__tests__/exams.test.ts') === null);
  git('checkout', '--', 'web/src/api/exams.ts');
  assert.ok(await ask('src/api/__tests__/exams.test.ts'), 'back: offered again (an unrelated base name does not count)');
});

// ---- finding 7: an untracked folder that is its own repository ---------------------------------------------------
test('an untracked folder that is its own Git repository is left out and named; the check still runs', async () => {
  const { repo, git } = fixture({ host: '', remoteRepo: '' });
  const plain = await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out });
  fs.mkdirSync(path.join(repo, 'scratch', 'fixture'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: path.join(repo, 'scratch', 'fixture'), windowsHide: true });
  const notes = [];
  const empty = await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out, note: line => notes.push(line) });
  assert.equal(empty.status, 'passed', empty.reason);
  assert.equal(empty.source.treeBefore, plain.source.treeBefore, 'the nested repository is not part of the checked source');
  assert.deepEqual(empty.source.nestedRepos, ['scratch/fixture/']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^NOTE: left out of the checked source .*scratch\/fixture\//);
  // With a commit inside it: the same.
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: path.join(repo, 'scratch', 'fixture'), windowsHide: true });
  assert.equal((await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out })).status, 'passed');
  // Still blocked: a tracked entry that is a repository (a submodule), and the reason names the path.
  const subDir = path.join(repo, 'tracked-sub');
  fs.mkdirSync(subDir);
  execFileSync('git', ['init', '-q'], { cwd: subDir, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: subDir, windowsHide: true });
  git('add', 'tracked-sub');
  const blocked = await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out });
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.reason, /Cannot capture the Git source tree before verification\. Submodule source cannot be bound by this check \(tracked-sub\)/);
});

// ---- finding 8: untracked files never match a commit ------------------------------------------------------------
test('untracked files are counted in the receipt and named in one NOTE line before the command starts', async () => {
  const { repo } = fixture({ host: '', remoteRepo: '' });
  const clean = [];
  const first = await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out, note: line => clean.push(line) });
  assert.deepEqual(clean, [], 'a clean tree: no note');
  assert.equal(first.source.untracked, undefined);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) fs.writeFileSync(path.join(repo, name), 'x');
  const notes = [];
  const result = await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out, note: line => notes.push(line) });
  assert.equal(result.status, 'passed', 'the check itself is not failed by it');
  assert.deepEqual(result.source.untracked, { count: 5, first: ['a.txt', 'b.txt', 'c.txt'] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^NOTE: 5 untracked files are in the checked source \(a\.txt, b\.txt, c\.txt and 2 more\)\. A commit that leaves them out will not match this receipt/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, 'metadata.json'), 'utf8')).source.untracked.count, 5);
});

// ---- finding 9: environment values must not rewrite the command words -------------------------------------------
test('an environment value that equals a word of the command does not change the receipt\'s command; logs still mask it', async () => {
  const { repo } = fixture({ host: '', remoteRepo: '' });
  const saved = process.env.DB_PASSWORD;
  process.env.DB_PASSWORD = 'test';
  try {
    const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("test")', 'test'], cwd: repo, outputRoot: out });
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.args, ['-e', 'console.log("test")', 'test']);
    assert.match(fs.readFileSync(result.stdout, 'utf8'), /\[REDACTED\]/, 'the log keeps the environment masking');
    // The spec's own secrets list and key=value words are still masked in the command words.
    const masked = await runCommand({ executable: process.execPath, args: ['-e', '0', 'hunter2-secret', 'password=abc123'], cwd: repo, outputRoot: out, secrets: ['hunter2-secret'] });
    assert.deepEqual(masked.args, ['-e', '0', '[REDACTED]', 'password=[REDACTED]']);
    assert.equal(redact('x test y'), 'x [REDACTED] y', 'redact() itself still masks environment values');
  } finally { if (saved === undefined) delete process.env.DB_PASSWORD; else process.env.DB_PASSWORD = saved; }
});
