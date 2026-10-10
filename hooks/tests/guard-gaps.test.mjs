import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Regressions for WORKFLOW-REVIEW-2026-09-23 findings F1-F5, run against the
// REAL hook processes with synthetic PreToolUse input. No command under test is
// ever executed; fixtures are disposable and hold only harmless values.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-gaps-'));
const fakeTemp = path.join(root, 'faketemp');
fs.mkdirSync(fakeTemp);
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function decide(hook, command, { cwd, tool = 'PowerShell', env = {} } = {}) {
  const input = JSON.stringify({ cwd, tool_name: tool, hook_event_name: 'PreToolUse', tool_input: { command } });
  const run = spawnSync(process.execPath, [path.join(hooks, hook)], {
    input, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, TEMP: fakeTemp, TMP: fakeTemp, ...env },
  });
  const out = run.stdout.trim() ? JSON.parse(run.stdout) : {};
  const h = out.hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '', status: run.status, stderr: run.stderr, ms: 0 };
}

function repo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'staging');
  gitIn(dir, 'config', 'user.name', 'developzone5');
  gitIn(dir, 'config', 'user.email', '65265330+developzone5@users.noreply.github.com');
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'fixture\n');
  gitIn(dir, 'add', 'app.txt');
  gitIn(dir, 'commit', '-q', '-m', 'test: seed fixture');
  return dir;
}

// A timed-out network probe can leave git's transport helper alive for a few
// seconds with its working directory inside the fixture; cleanup is best-effort.
test.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch { /* temp dir */ } });

test('F5: gh merge, release and ref writes are denied in every flag position and wrapper', () => {
  const cwd = repo('gh');
  for (const command of ['gh -R o/r pr merge 1', 'gh pr -R o/r merge 1', 'gh -Ro/r pr merge 1', 'gh --repo=o/r pr merge 1',
    "& 'C:\\Program Files\\GitHub CLI\\gh.exe' pr merge 1", 'bash -c "gh pr merge 1"', 'if ($?) { gh pr merge 1 }', '(gh pr merge 1)',
    'gh api -X PUT repos/o/r/pulls/1/merge', 'gh api repos/o/r/merges -f base=main -f head=x',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', 'gh api graphql -f query="$Q"', 'gh -R o/r release delete v1',
    'echo ok; if ($?) { gh pr create --base main --fill }', 'git --no-optional-locks push origin HEAD:main',
    'git --git-dir .git push origin feature', 'git -c alias.ship=push ship origin HEAD:main']) {
    assert.equal(decide('policy-guard.js', command, { cwd }).decision, 'deny', command);
  }
  assert.equal(decide('policy-guard.js', 'gh alias set m "pr merge"', { cwd }).decision, 'ask');
  for (const command of ['gh pr view 1', 'gh api repos/o/r/pulls', 'gh pr list --search merge']) {
    assert.equal(decide('policy-guard.js', command, { cwd }).decision, 'allow', command);
  }
});

test('F3: every publish spelling, dependency addition and branch deletion asks; routine commands stay silent', () => {
  const cwd = repo('pm');
  for (const command of ['npm.cmd publish', '"C:\\Program Files\\nodejs\\npm.cmd" publish', 'node node_modules/npm/bin/npm-cli.js publish',
    'yarn npm publish', 'npm unpublish x', 'npm --workspace x publish', 'dotnet nuget push a.nupkg', 'pnpm add lodash', 'npm i lodash',
    'npm install lodash --save-dev', 'yarn add x', 'bun add x', 'dotnet add package Serilog', 'dotnet package add Serilog',
    'pip install requests', 'python -m pip install requests', 'git branch -d old', 'git branch -D old',
    'git branch --merged | xargs git branch -d']) {
    assert.equal(decide('policy-guard.js', command, { cwd }).decision, 'ask', command);
  }
  for (const command of ['npm ci', 'npm install', 'npm run build', 'npm test', 'pip install -r requirements.txt', 'git branch -a',
    'git branch --show-current', 'git branch -vv', 'dotnet add reference ../x/x.csproj', 'dotnet test']) {
    assert.equal(decide('policy-guard.js', command, { cwd }).decision, 'allow', command);
  }
});

test('F2: delete exemptions follow the resolved target, not the path text', () => {
  const cwd = repo('del');
  fs.mkdirSync(path.join(cwd, 'bin'));  fs.writeFileSync(path.join(cwd, 'bin', 'out.dll'), 'x');
  fs.mkdirSync(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'dist')); fs.writeFileSync(path.join(cwd, 'dist', 'app.js'), 'tracked');
  fs.mkdirSync(path.join(cwd, 'build', 'src'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'build', 'src', 'a.cs'), 'tracked');
  gitIn(cwd, 'add', 'dist/app.js', 'build/src/a.cs'); gitIn(cwd, 'commit', '-q', '-m', 'test: tracked output-named dirs');
  const outside = path.join(root, 'outside-target'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, 'obj'), 'junction');
  fs.mkdirSync(path.join(fakeTemp, 'junk'));

  const allowCases = [['Remove-Item -Recurse -Force bin', 'PowerShell'], ['rm -rf node_modules', 'Bash'],
    ['Remove-Item -Recurse -Force "' + path.join(fakeTemp, 'junk') + '"', 'PowerShell']];
  const askCases = [['Remove-Item -Recurse -Force dist', 'PowerShell'], ['rm -rf project/bin/..', 'Bash'],
    ['Remove-Item -Recurse -Force build/src', 'PowerShell'], ['Remove-Item -r -fo src', 'PowerShell'],
    ['Remove-Item -Recurse:$true src', 'PowerShell'], ['Remove-Item -Recurse -Force .\\src,.\\bin', 'PowerShell'],
    ['Remove-Item -Recurse -Force "C:\\Program Files\\Git\\usr\\bin"', 'PowerShell'], ['Remove-Item -Recurse -Force obj', 'PowerShell'],
    ['Remove-Item -Recurse -Force \\\\server\\share\\bin', 'PowerShell'], ['rm -rf /tmp/../c/Users/someone/project', 'Bash'],
    ['cmd /c rmdir /s /q src', 'PowerShell'], ['npx rimraf src', 'PowerShell'], ['rm -rf ~/x', 'Bash']];
  const denyCases = [['rm -rf /', 'Bash'], ['Remove-Item -Recurse C:\\', 'PowerShell'], ['rm -rf ~', 'Bash'], ['rm -rf /c', 'Bash']];
  for (const [command, tool] of allowCases) assert.equal(decide('policy-guard.js', command, { cwd, tool }).decision, 'allow', command);
  for (const [command, tool] of askCases) assert.equal(decide('policy-guard.js', command, { cwd, tool }).decision, 'ask', command);
  for (const [command, tool] of denyCases) assert.equal(decide('policy-guard.js', command, { cwd, tool }).decision, 'deny', command);
  assert.ok(fs.existsSync(path.join(cwd, 'bin', 'out.dll')), 'the hook never executes the command');
});

// Harmless, structurally valid fixture values, assembled at runtime so no
// literal credential-shaped string lives in this file.
const fakeAwsKey = ['AK', 'IA', 'FIXTUREFIXTURE00'].join('');
const envFixture = 'FIXTURE_ONLY=not-a-credential\n';
const msys = p => p.replace(/^([A-Za-z]):\\/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');

test('F2: a differently spelled but identical directory still gets the build-output exemption', () => {
  // The guard must judge the real target, not its spelling: a junction to the repo, or a
  // Windows short (8.3) name such as RUNNER~1 on GitHub runners, names the same folder.
  const cwd = repo('del-alias');
  fs.mkdirSync(path.join(cwd, 'bin')); fs.writeFileSync(path.join(cwd, 'bin', 'out.dll'), 'x');
  const alias = path.join(root, 'del-alias-link');
  fs.symlinkSync(cwd, alias, 'junction');
  assert.equal(decide('policy-guard.js', 'Remove-Item -Recurse -Force bin', { cwd: alias }).decision, 'allow', 'cwd through a junction');
  const escape = path.join(root, 'elsewhere'); fs.mkdirSync(escape); fs.mkdirSync(path.join(escape, 'bin'));
  fs.symlinkSync(escape, path.join(cwd, 'vendor'), 'junction');
  assert.equal(decide('policy-guard.js', 'Remove-Item -Recurse -Force vendor/bin', { cwd }).decision, 'ask', 'a junction that leaves the repo still asks');
  if (process.platform === 'win32') {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('" + cwd.replace(/'/g, "''") + "').ShortPath"], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const short = probe.status === 0 ? probe.stdout.trim() : '';
    if (short && fs.existsSync(short) && short.toLowerCase() !== cwd.toLowerCase()) {
      assert.equal(decide('policy-guard.js', 'Remove-Item -Recurse -Force bin', { cwd: short }).decision, 'allow', 'cwd given as a short 8.3 path: ' + short);
    }
  }
  assert.ok(fs.existsSync(path.join(cwd, 'bin', 'out.dll')), 'the hook never executes the command');
});
test('F1: the secret scan reads the repository the command actually targets', () => {
  const victim = repo('f1-victim');
  fs.writeFileSync(path.join(victim, '.env'), envFixture);
  gitIn(victim, 'add', '.env');
  const clean = repo('f1-clean');
  const other = repo('f1-other');
  fs.writeFileSync(path.join(other, 'notes.txt'), 'plain change\n'); gitIn(other, 'add', 'notes.txt');
  const gitExe = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find(l => /\.exe$/i.test(l.trim())).trim();
  const home = path.relative(os.homedir(), victim).replace(/\\/g, '/');
  const denyCases = [['git -C "' + victim + '" commit -m x', 'PowerShell'], ['cd ' + msys(victim) + ' && git commit -m x', 'Bash'],
    ['cd ~/' + home + ' && git commit -m x', 'Bash'], ["Set-Location -LiteralPath '" + victim + "'; git commit -m x", 'PowerShell'],
    ['Push-Location "' + victim + '"; git commit -m x', 'PowerShell'], ['& "' + gitExe + '" -C "' + victim + '" commit -m x', 'PowerShell'],
    ['git add .env; if ($?) { git -C "' + victim + '" commit -m x }', 'PowerShell']];
  for (const [command, tool] of denyCases) {
    const d = decide('precommit-guard.js', command, { cwd: clean, tool });
    assert.equal(d.decision, 'deny', command);
    assert.match(d.reason, /credential file/, command);
  }
  assert.equal(decide('precommit-guard.js', 'git -C "' + other + '" commit -m x', { cwd: victim }).decision, 'allow');
  assert.equal(decide('precommit-guard.js', 'cd $env:SOMEWHERE; git commit -m x', { cwd: clean }).decision, 'ask');
  assert.equal(decide('precommit-guard.js', 'GIT_DIR=x git commit -m x', { cwd: clean, tool: 'Bash' }).decision, 'ask');
  assert.equal(decide('precommit-guard.js', 'git --git-dir .git push origin feature', { cwd: clean, tool: 'Bash' }).decision, 'deny');
  assert.equal(decide('precommit-guard.js', 'echo "then git push"', { cwd: clean }).decision, 'allow');
  const notRepo = path.join(root, 'not-a-repo'); fs.mkdirSync(notRepo);
  assert.equal(decide('precommit-guard.js', 'git commit -m x', { cwd: notRepo }).decision, 'allow');
});

test('F1: changes staged by the same command are scanned before the commit runs', () => {
  const dir = repo('f1-stage');
  fs.writeFileSync(path.join(dir, 'settings.txt'), 'plain\n'); gitIn(dir, 'add', 'settings.txt'); gitIn(dir, 'commit', '-q', '-m', 'test: base');
  fs.writeFileSync(path.join(dir, '.env.local'), envFixture);
  assert.equal(decide('precommit-guard.js', 'git add .env.local; if ($?) { git commit -m x }', { cwd: dir }).decision, 'deny');
  assert.equal(decide('precommit-guard.js', 'git add .env.local && git commit -m x', { cwd: dir, tool: 'Bash' }).decision, 'deny');
  fs.rmSync(path.join(dir, '.env.local'));
  fs.writeFileSync(path.join(dir, 'settings.txt'), 'key = "' + fakeAwsKey + '"\n');
  assert.equal(decide('precommit-guard.js', 'git commit -am x', { cwd: dir }).decision, 'deny');
  assert.equal(decide('precommit-guard.js', 'git commit settings.txt -m x', { cwd: dir }).decision, 'deny');
  assert.equal(decide('precommit-guard.js', 'git commit -m x', { cwd: dir }).decision, 'allow', 'unstaged edits are not in a plain commit');
});

test('the C# format guard refuses a partly staged file it cannot judge', () => {
  const dir = repo('csharpier-partial');
  fs.mkdirSync(path.join(dir, '.config'));
  fs.writeFileSync(path.join(dir, '.config', 'dotnet-tools.json'), '{"tools":{"csharpier":{}}}\n');
  fs.writeFileSync(path.join(dir, 'App.cs'), 'class App { }\n');
  gitIn(dir, 'add', 'App.cs'); gitIn(dir, 'commit', '-q', '-m', 'test: base');
  fs.writeFileSync(path.join(dir, 'App.cs'), 'class App { int a; }\n'); gitIn(dir, 'add', 'App.cs');
  fs.writeFileSync(path.join(dir, 'App.cs'), 'class App { int a; int b; }\n');
  const d = decide('csharpier-guard.js', 'git commit -m x', { cwd: dir });
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /partly staged/);
});

test('session start labels remote comparisons as stale when fetch fails', () => {
  const dir = repo('start-offline');
  gitIn(dir, 'remote', 'add', 'origin', path.join(root, 'missing-remote.git'));
  const start = (cwd) => spawnSync(process.execPath, [path.join(hooks, 'session-start.js')], { input: JSON.stringify({ cwd }), encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout;
  assert.match(start(dir), /fetch origin failed/);
  const online = repo('start-online');
  const bare = path.join(root, 'start-online-remote.git');
  gitIn(root, 'clone', '-q', '--bare', online, bare);
  gitIn(online, 'remote', 'add', 'origin', bare);
  assert.doesNotMatch(start(online), /fetch origin failed|last fetched state/);
});

test('F1: a new ordinary file staged by the same command has its contents scanned', () => {
  const dir = repo('f1-new-file');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'leak.cs'), 'var key = "' + fakeAwsKey + '";\n');
  assert.equal(decide('precommit-guard.js', 'git add src/leak.cs; git commit -m x', { cwd: dir }).decision, 'deny');
  assert.equal(decide('precommit-guard.js', 'git add src/leak.cs && git commit -m x', { cwd: dir, tool: 'Bash' }).decision, 'deny');
  assert.equal(decide('precommit-guard.js', 'git commit src/leak.cs -m x', { cwd: dir }).decision, 'deny');
  fs.writeFileSync(path.join(dir, 'src', 'leak.cs'), 'var key = "not a secret";\n');
  assert.equal(decide('precommit-guard.js', 'git add src/leak.cs; git commit -m x', { cwd: dir }).decision, 'allow', 'a clean new file is committed');
});

function pushFixture(name) {
  const src = repo(name);
  fs.writeFileSync(path.join(src, 'db.txt'), 'Server=x;Pass' + 'word=fixture123\n');   // already public on the remote; split so this source file is not itself flagged
  gitIn(src, 'add', 'db.txt'); gitIn(src, 'commit', '-q', '-m', 'test: public base');
  const bare = path.join(root, name + '-remote.git');
  gitIn(root, 'clone', '-q', '--bare', src, bare);
  gitIn(src, 'remote', 'add', 'origin', bare);
  gitIn(src, 'fetch', '-q', 'origin');
  gitIn(src, 'branch', '-q', '--set-upstream-to=origin/staging');
  return src;
}
const commitFile = (dir, file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); gitIn(dir, 'add', file); gitIn(dir, 'commit', '-q', '-m', msg); };

test('F4: every outgoing commit is scanned against what the remote really has', () => {
  const removed = pushFixture('f4-removed');
  commitFile(removed, '.env', envFixture, 'test: add env');
  gitIn(removed, 'rm', '-q', '.env'); gitIn(removed, 'commit', '-q', '-m', 'test: remove env');
  const d1 = decide('precommit-guard.js', 'git push origin staging', { cwd: removed });
  assert.equal(d1.decision, 'deny'); assert.match(d1.reason, /credential file.*later commit/);

  const placeholder = pushFixture('f4-placeholder');
  commitFile(placeholder, 'cfg.txt', 'key = "' + fakeAwsKey + '"\n', 'test: key');
  commitFile(placeholder, 'cfg.txt', 'key = "<from-secret-store>"\n', 'test: placeholder');
  assert.equal(decide('precommit-guard.js', 'git push', { cwd: placeholder }).decision, 'deny');

  const renamed = pushFixture('f4-renamed');
  commitFile(renamed, 'notes.txt', envFixture, 'test: notes');
  gitIn(renamed, 'mv', 'notes.txt', '.env'); gitIn(renamed, 'commit', '-q', '-m', 'test: rename');
  assert.equal(decide('precommit-guard.js', 'git push origin HEAD', { cwd: renamed }).decision, 'deny');

  const forged = pushFixture('f4-forged');
  commitFile(forged, '.env', envFixture, 'test: add env');
  gitIn(forged, 'fetch', '-q', '.', 'HEAD:refs/remotes/origin/staging');          // local refs now claim it is public
  assert.equal(decide('precommit-guard.js', 'git push origin staging', { cwd: forged }).decision, 'deny');

  const clean = pushFixture('f4-clean');
  commitFile(clean, 'a.txt', 'one\n', 'test: one'); commitFile(clean, 'b.txt', 'two\n', 'test: two'); commitFile(clean, 'c.txt', 'three\n', 'test: three');
  assert.equal(decide('precommit-guard.js', 'git push origin staging', { cwd: clean }).decision, 'allow');
  gitIn(clean, 'mv', 'db.txt', 'db2.txt'); gitIn(clean, 'commit', '-q', '-m', 'test: move public file');
  assert.equal(decide('precommit-guard.js', 'git push origin staging', { cwd: clean }).decision, 'allow', 'moving already-public content is not new content');
  assert.equal(decide('precommit-guard.js', 'git push origin --delete old-branch', { cwd: clean }).decision, 'allow');
});

test('F4: an unreadable remote or an oversized outgoing set denies within the deadline', () => {
  const unreachable = pushFixture('f4-unreachable');
  gitIn(unreachable, 'remote', 'set-url', 'origin', 'https://10.255.255.1/fixture.git');
  commitFile(unreachable, 'a.txt', 'one\n', 'test: one');
  const started = Date.now();
  const d = decide('precommit-guard.js', 'git push origin staging', { cwd: unreachable });
  assert.equal(d.decision, 'deny'); assert.match(d.reason, /Nothing was verified/);
  assert.ok(Date.now() - started < 13000, 'decision arrives before the hook timeout');

  const big = pushFixture('f4-big');
  const line = 'x'.repeat(99) + '\n';
  fs.writeFileSync(path.join(big, 'bulk.txt'), line.repeat(400000));                   // ~40 MB of new lines
  gitIn(big, 'add', 'bulk.txt'); gitIn(big, 'commit', '-q', '-m', 'test: bulk');
  const b = decide('precommit-guard.js', 'git push origin staging', { cwd: big });
  assert.equal(b.decision, 'deny'); assert.match(b.reason, /scan limit/);
});

test('lib missing: guarded actions fail closed, deletes ask, other commands pass', () => {
  const staged = path.join(root, 'staged-hooks');
  fs.mkdirSync(path.join(staged, 'lib'), { recursive: true });
  for (const f of ['policy-guard.js', 'precommit-guard.js']) fs.copyFileSync(path.join(hooks, f), path.join(staged, f));
  const cwd = repo('nolib');
  const run = (hook, command) => {
    const r = spawnSync(process.execPath, [path.join(staged, hook)], { input: JSON.stringify({ cwd, tool_name: 'PowerShell', tool_input: { command } }), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return (JSON.parse(r.stdout.trim() || '{}').hookSpecificOutput || {}).permissionDecision || 'allow';
  };
  assert.equal(run('policy-guard.js', 'gh pr merge 1'), 'deny');
  assert.equal(run('policy-guard.js', 'git push origin feature'), 'deny');
  assert.equal(run('policy-guard.js', 'npm publish'), 'deny');
  assert.equal(run('policy-guard.js', 'Remove-Item -Recurse src'), 'ask');
  assert.equal(run('policy-guard.js', 'dotnet test'), 'allow');
  assert.equal(run('precommit-guard.js', 'git commit -m x'), 'deny');
  assert.equal(run('precommit-guard.js', 'git push origin feature'), 'deny');
  assert.equal(run('precommit-guard.js', 'dotnet build'), 'allow');
});
