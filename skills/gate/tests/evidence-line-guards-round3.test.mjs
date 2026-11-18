// 2026-11-18, round 3 of the audit of the receipt promise ("a failed, cut-short, piped or wrong-folder run never
// yields a passing receipt"): findings 3 and 4 closed further. Each test starts with the input of the problem (it
// passed before), then pins the nearest normal flow that must keep passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCommand, remoteTarget, rerunSuggestion } from '../scripts/evidence.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-round3-'));
process.env.SANAD_CHECK_LOCK_DIR = path.join(root, 'locks');
test.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left to the temp cleaner */ } });
const emptyIgnore = path.join(root, 'empty-ignore');
fs.writeFileSync(emptyIgnore, '');
const out = path.join(root, 'out');
const copyAs = name => {
  const file = path.join(root, process.platform === 'win32' ? name + '.exe' : name);
  fs.copyFileSync(process.execPath, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
};
const ssh = copyAs('ssh');
const THERE = 'C:/Users/Tester/source/repos/App';
const WIN_THERE = THERE.replace(/\//g, '\\');

function fixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Evidence fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false'); git('config', 'core.excludesFile', emptyIgnore);
  git('config', 'sanad.remoteHost', 'pc2'); git('config', 'sanad.remoteRepo', THERE);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-qm', 'fixture');
  return { repo, git };
}
const treeOf = async repo => (await runCommand({ executable: process.execPath, args: ['-e', '0'], cwd: repo, outputRoot: out })).source.treeBefore;
let markers = 0;
const sameTreeProbe = tree => () => ({ tree, dirty: '' });
async function remoteRun(repo, line, probe) {
  const marker = path.join(root, 'marker-' + (++markers));
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  const result = await runCommand({ executable: ssh, args: ['-e', script, 'pc2', line], cwd: repo, outputRoot: out, remoteProbe: probe });
  return { result, ran: fs.existsSync(marker) };
}

test('a cd written without a space, or a cd-like word that cannot be read, leaves the clone', async () => {
  const { repo } = fixture();
  for (const line of [`cd /d ${WIN_THERE} && cd..\\App-old && node check.js`, `cd /d ${WIN_THERE} && cd/d C:\\other && node check.js`,
    `cd /d ${WIN_THERE} && cd\\other && node check.js`, `cd /d ${WIN_THERE} && cd%X% && node check.js`, `cd /d ${WIN_THERE} && popd && node check.js`,
    `cd /d ${WIN_THERE} && chdir..\\x && node check.js`, `cd /d ${WIN_THERE} && @cd ..\\x && node check.js`]) {
    assert.equal(remoteTarget(ssh, ['pc2', line], repo), null, line);
  }
  const { result, ran } = await remoteRun(repo, `cd /d ${WIN_THERE} && cd..\\App-old && node check.js`, sameTreeProbe(await treeOf(repo)));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /not bound to the test machine clone/);
  assert.equal(ran, false);
  // must not change: a tight cd that stays inside the clone, and words that only start with "cd"
  for (const line of [`cd /d ${WIN_THERE} && cd..\\App\\web && node -v`, `cd/d ${WIN_THERE}\\web && node -v`, `cd /d ${WIN_THERE} && cdk synth`, `cd /d ${WIN_THERE} && cd web && cd .. && node -v`]) {
    assert.ok(remoteTarget(ssh, ['pc2', line], repo), line);
  }
});

test('a path argument of a bound ssh line that leaves the clone fails the receipt before the command starts', async () => {
  const { repo } = fixture();
  const probe = sameTreeProbe(await treeOf(repo));
  for (const line of [`cd /d ${WIN_THERE} && node ..\\App-old\\check.js`, `cd /d ${WIN_THERE} && node C:\\other\\check.js`, `cd /d ${WIN_THERE}\\web && node ..\\..\\App-old\\check.js`,
    `cd /d ${WIN_THERE} && node check.js --root=..\\App-old`, `cd /d ${WIN_THERE} && dotnet test ../App-old/T.csproj`]) {
    const { result, ran } = await remoteRun(repo, line, probe);
    assert.equal(result.status, 'failed', line);
    assert.match(result.reason, /outside the test machine clone/, line);
    assert.equal(result.nativeExitCode, null);
    assert.equal(ran, false, line);
  }
  // must not change: paths inside the clone, node_modules, options with a colon or value, a quoted text, the program word
  for (const line of [`cd /d ${WIN_THERE} && node check.js`, `cd /d ${WIN_THERE}\\web && node ..\\check.js`, `cd /d ${WIN_THERE} && node node_modules\\vitest\\vitest.mjs run src\\a.test.ts`,
    `cd /d ${WIN_THERE} && msbuild App.sln /nologo /p:OutDir=C:\\out\\ /v:q`, `cd /d ${WIN_THERE} && node check.js --grep "a b" 2>&1`,
    `cd /d ${WIN_THERE} && node check.js ${WIN_THERE}\\web\\a.test.ts`, `cd /d ${WIN_THERE} && node C:\\tools\\node_modules\\x\\y.js`, `cd /d ${WIN_THERE} && C:\\tools\\node.exe check.js`]) {
    const { result, ran } = await remoteRun(repo, line, probe);
    assert.equal(result.status, 'passed', line + ' -> ' + result.reason);
    assert.equal(ran, true, line);
  }
});

test('a glob word, and words glued to "&&" or "(", that reach a nested repository fail the receipt', async () => {
  const { repo } = fixture();
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const ng = (...args) => execFileSync('git', args, { cwd: nested, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ng('init', '-q'); ng('config', 'user.name', 'N'); ng('config', 'user.email', 'n@example.invalid');
  fs.writeFileSync(path.join(nested, 'unit.test.cjs'), ''); ng('add', '.'); ng('commit', '-qm', 'n');
  const run = args => runCommand({ executable: process.execPath, args: ['-e', '0', '--', ...args], cwd: repo, outputRoot: out });
  const cmd = copyAs('cmd');
  for (const args of [['nest*/unit.test.cjs'], ['**/unit.test.cjs'], ['nest?d/unit.test.cjs'], ['{nested,x}/unit.test.cjs']]) {
    const result = await run(args);
    assert.equal(result.status, 'failed', args.join(' '));
    assert.match(result.reason, /another Git work tree/, args.join(' '));
    assert.equal(result.nativeExitCode, null);
  }
  for (const script of ['cd nested&&node --test unit.test.cjs', '(cd nested)&&node -v']) {
    const result = await runCommand({ executable: cmd, args: ['/c', script], cwd: repo, outputRoot: out });
    assert.equal(result.status, 'failed', script);
    assert.match(result.reason, /another Git work tree/, script);
    assert.equal(result.nativeExitCode, null);
  }
  // must not change: globs that match nothing or only this repository, and a glued line inside this repository
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.test.js'), '');
  for (const args of [['src/*.test.js'], ['**/a.test.js'], ['no-such*/x.js'], ['--grep', 'a*b'], ['[ab]pp.js']]) {
    const result = await run(args);
    assert.equal(result.status, 'passed', args.join(' ') + ' -> ' + result.reason);
  }
  const inside = await runCommand({ executable: cmd, args: ['/c', 'cd src&&node -v'], cwd: repo, outputRoot: out });
  assert.doesNotMatch(String(inside.reason), /another Git work tree|outside quotes/);
});

test('a powershell -Command line is read like cmd /c: ";" and "|" fail, an ssh inside fails, quoted operators pass', async () => {
  const { repo } = fixture();
  const ps = copyAs('powershell'), pwsh = copyAs('pwsh');
  for (const [executable, args] of [[ps, ['-NoProfile', '-Command', 'node fail.js; echo done']], [ps, ['-NoProfile', '-Command', 'node fail.js | Out-Host; exit 0']],
    [pwsh, ['-c', 'node fail.js || echo x']], [ps, ['-Command', 'node', 'fail.js;', 'exit', '0']]]) {
    const result = await runCommand({ executable, args, cwd: repo, outputRoot: out });
    assert.equal(result.status, 'failed', args.join(' '));
    assert.match(result.reason, /outside quotes/, args.join(' '));
    assert.equal(result.nativeExitCode, null);
  }
  const wrapped = await runCommand({ executable: ps, args: ['-NoProfile', '-Command', `ssh pc2 'cd /d ${WIN_THERE} && node check.js'`], cwd: repo, outputRoot: out });
  assert.equal(wrapped.status, 'failed');
  assert.match(wrapped.reason, /ssh inside another shell line/);
  // must not change: single quotes, double quotes and a plain line are not refused for their line
  for (const script of ["node -e 'a;b|c'", 'node -e "a;b|c" && node -v', 'node -v 2>&1', '& node -v']) {
    const result = await runCommand({ executable: ps, args: ['-NoProfile', '-Command', script], cwd: repo, outputRoot: out });
    assert.doesNotMatch(String(result.reason), /outside quotes|ssh inside/, script);
  }
});

test('a timeout in a test is not offered a rerun when a source file of the same name changed, whatever the folder layout', async () => {
  const repo = fs.mkdtempSync(path.join(root, 'task-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.excludesFile', emptyIgnore);
  const layouts = ['tests/unit/api/exams.test.ts', 'src/api/__test__/exams.test.ts', 'src/api/__tests__/unit/exams.test.ts', 'src/api/exams.spec.ts', 'src/api/__tests__/exams.test.ts'];
  const files = { 'web/src/api/exams.ts': 'export {};\n', 'web/src/api/other.ts': 'export {};\n', 'web/src/api/examsx.ts': 'export {};\n' };
  for (const l of layouts) files['web/' + l] = 'it("x")\n';
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); }
  git('add', 'web'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  const web = path.join(repo, 'web');
  const ask = async file => {
    const logs = fs.mkdtempSync(path.join(root, 'logs-'));
    fs.writeFileSync(path.join(logs, 'stdout.log'), [' ❯ ' + file + ' (12 tests | 1 failed) 5123ms', ' Test Files  1 failed | 111 passed (112)', '      Tests  1 failed | 1758 passed (1759)'].join('\n') + '\n');
    fs.writeFileSync(path.join(logs, 'stderr.log'), ['', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯', '', ` FAIL  ${file} > it > slow`, 'Error: Test timed out in 5000ms.', ' ❯ ' + file + ':4:3', '', '⎯⎯⎯[1/1]⎯', ''].join('\n'));
    return rerunSuggestion({ receipt: { status: 'failed', nativeExitCode: 1, signal: null, reason: null, stdout: path.join(logs, 'stdout.log'), stderr: path.join(logs, 'stderr.log'), source: { toplevel: fs.realpathSync.native(repo) } },
      spec: { executable: process.execPath, args: ['node_modules/vitest/vitest.mjs', 'run'], cwd: web, outputRoot: root }, specArg: 'C:/checks/frontend-full.json', script: 'C:/u/.claude/skills/gate/scripts/evidence.mjs' });
  };
  fs.appendFileSync(path.join(web, 'src/api/other.ts'), '// the task\n');
  fs.appendFileSync(path.join(web, 'src/api/examsx.ts'), '// the task\n');
  for (const l of layouts) assert.ok(await ask(l), 'nothing it is named after changed: offered ' + l);
  fs.appendFileSync(path.join(web, 'src/api/exams.ts'), '// slower now\n');
  for (const l of layouts) assert.equal(await ask(l), null, 'its source file changed: ' + l);
});
