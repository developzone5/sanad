import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, after } from 'node:test';

// 2026-11-12 audit H1, H3, H8/H15, H13, H18, H19: the guards must see commands handed to
// another program (ssh, here-documents, wrappers, saved aliases) and judge pushes from every
// passing receipt. Hook processes get synthetic PreToolUse input; no command under test runs.
const queued = [];
const test = (name, fn) => { queued.push([name, fn]); };

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shell = require(path.join(hooks, 'lib', 'shell-command.cjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nested-'));
const fakeTemp = path.join(root, 'faketemp');
fs.mkdirSync(fakeTemp);
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch { /* temp dir */ } });

function spawnHook(script, input, { env = process.env, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function decide(hook, command, { cwd, tool = 'PowerShell' } = {}) {
  const input = JSON.stringify({ cwd, tool_name: tool, hook_event_name: 'PreToolUse', tool_input: { command } });
  const started = Date.now();
  const run = await spawnHook(path.join(hooks, hook), input, { env: { ...process.env, TEMP: fakeTemp, TMP: fakeTemp } });
  const out = run.stdout.trim() ? JSON.parse(run.stdout) : {};
  const h = out.hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '', stderr: run.stderr, ms: Date.now() - started };
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
// A repository whose next push would publish a credential file: precommit-guard denies
// exactly when it sees (and scans) the push.
const envFixture = 'FIXTURE_ONLY=not-a-credential\n';
function leakyPush(name) {
  const src = repo(name);
  const bare = path.join(root, name + '-remote.git');
  gitIn(root, 'clone', '-q', '--bare', src, bare);
  gitIn(src, 'remote', 'add', 'origin', bare);
  gitIn(src, 'fetch', '-q', 'origin');
  fs.writeFileSync(path.join(src, '.env'), envFixture);
  gitIn(src, 'add', '.env'); gitIn(src, 'commit', '-q', '-m', 'test: add env');
  return src;
}
const msys = p => p.replace(/^([A-Za-z]):\\/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');
const base = 'C:\\work\\repo';
const parse = (cmd, tool = 'Bash', extra = {}) => shell.parseCommand(cmd, { cwd: base, tool, home: 'C:\\Users\\dev', tmp: 'C:\\Users\\dev\\AppData\\Local\\Temp', ...extra });
const gits = (cmd, tool, extra) => parse(cmd, tool, extra).filter(r => r.git);

// ---------------------------------------------------------------------------
// H1: the grammar looks inside ssh, here-documents and other hand-offs
// ---------------------------------------------------------------------------

test('H1 grammar: the remote command of ssh is parsed and marked as another machine', () => {
  for (const cmd of ['ssh pc2 "cd /repo && git push --force origin HEAD:main"', 'ssh -o ConnectTimeout=10 -p 22 pc2 "git push"',
    'ssh pc2 git push origin HEAD:x', "ssh -t pc2 'bash -lc \"cd /r && git push\"'", 'ssh -i key -At -- pc2 git push',
    'timeout 590 ssh pc2 "cd /d C:\\r\\x && git push"']) {
    const push = gits(cmd).find(g => g.git.sub === 'push');
    assert.ok(push, cmd);
    assert.equal(push.remote, 'pc2', cmd);
    assert.equal(push.cwd, null, 'a remote directory is never a local one: ' + cmd);
  }
  assert.equal(parse('ssh -N -L 3000:localhost:3000 pc2').length, 1, 'a tunnel runs nothing');
  assert.deepEqual(parse('ssh pc2 "docker compose down -v"').map(r => [r.program, r.remote]), [['ssh', ''], ['docker', 'pc2']]);
});

test('H1 grammar: here-document bodies fed to a shell, ssh or a database client are seen', () => {
  const nested = (cmd, program) => parse(cmd).filter(r => r.nested && r.program === program);
  assert.equal(nested("bash <<'EOF'\ncd x\ngit push origin HEAD:main\nEOF", 'git')[0].git.sub, 'push');
  assert.equal(nested("bash <<'EOF'\ncd x\ngit push origin HEAD:main\nEOF", 'git')[0].cwd, path.join(base, 'x'), 'a local shell keeps the directory');
  assert.equal(nested("sh -s <<EOF\nrm -rf src\nEOF", 'rm').length, 1);
  assert.equal(nested("cat <<'EOF' | bash\ngit push\nEOF", 'git')[0].git.sub, 'push');
  assert.equal(nested('echo "git push origin HEAD:main" | bash', 'git')[0].git.sub, 'push');
  const remote = nested("ssh pc2 bash -s <<'EOF'\ncd /repo\ngit push --force\nEOF", 'git');
  assert.equal(remote[0].git.sub, 'push'); assert.equal(remote[0].remote, 'pc2');
  assert.equal(nested("ssh pc2 <<'EOF'\ngit reset --hard\nEOF", 'git')[0].git.sub, 'reset');
  assert.equal(nested("powershell -NoProfile -Command - <<'EOF'\ngit push\nEOF", 'git')[0].git.sub, 'push');
  assert.equal(nested("cmd <<'EOF'\nrd /s /q src\nEOF", 'rd').length, 1);
  const sql = parse("docker exec -i db mysql -uroot <<'SQL'\nDROP TABLE Users;\nSQL").find(r => r.program === 'docker');
  assert.match(sql.stdin, /DROP TABLE Users/);
  assert.match(parse("mysql -uroot <<SQL\nTRUNCATE TABLE x;\nSQL")[0].stdin, /TRUNCATE/);
  assert.match(parse('ssh pc2 "docker exec -i db mysql" <<\'SQL\'\nDROP TABLE x;\nSQL').find(r => r.program === 'docker').stdin, /DROP TABLE x/);
  assert.equal(nested('bash <<< "git push origin HEAD:main"', 'git')[0].git.sub, 'push');
  // Text only: a heredoc that is a commit message or a file body runs nothing.
  assert.deepEqual(gits("git commit -F - <<'EOF'\nfix: nested push detection\nEOF").map(r => r.git.sub), ['commit']);
  assert.deepEqual(parse("cat > notes.md <<'EOF'\nthen git push --force\nEOF").map(r => r.program), ['cat']);
  assert.deepEqual(parse("bash build.sh <<'EOF'\ngit push\nEOF").map(r => r.program), ['bash'], 'a script reads the body as data');
  // A command after the heredoc marker on the same line is still a command.
  assert.deepEqual(gits("git commit -F - <<'EOF' && git push origin HEAD:x\nmsg\nEOF").map(r => r.git.sub), ['commit', 'push']);
});

test('H1 grammar: wsl hands its command to Linux in the same folder', () => {
  const [g] = gits('wsl -- git push origin HEAD:main', 'PowerShell');
  assert.equal(g.git.sub, 'push'); assert.equal(g.cwd, base);
  assert.equal(gits('wsl -d Ubuntu -e git push', 'PowerShell')[0].git.sub, 'push');
  assert.equal(gits('wsl --cd /tmp git push', 'PowerShell')[0].cwd, null);
  assert.equal(parse('wsl --shutdown', 'PowerShell').length, 1);
});

// ---------------------------------------------------------------------------
// H18: wrappers, aliases
// ---------------------------------------------------------------------------

test('H18 grammar: leading wrappers never hide the program', () => {
  for (const cmd of ['timeout -k 5 600 git push', 'timeout --signal=KILL 10s git push', 'env -i git push', 'env -i PATH=/x git push',
    'env -u HOME git push', 'nice -n 10 git push', 'nice git push', 'nohup git push', 'time -p git push', 'command git push',
    'winpty git push', 'stdbuf -oL -eL git push', 'sudo -u me git push', 'sudo -E git push', 'timeout 600 nice -n 5 env FOO=1 git push']) {
    const [g] = gits(cmd);
    assert.ok(g, cmd);
    assert.equal(g.git.sub, 'push', cmd);
    assert.equal(g.cwd, base, cmd);
  }
  assert.equal(gits('env -C /elsewhere git push')[0].cwd, null, 'env -C moves the directory');
  assert.deepEqual(parse('timeout 600 dotnet test').map(r => r.program), ['dotnet']);
});

test('H18 grammar: a saved alias is resolved once, only for an unknown word', () => {
  const asked = [];
  const resolveAlias = (word, dir) => { asked.push([word, dir]); return { pf: 'push --force', sh: '!git push origin HEAD:main', st: 'status' }[word] || ''; };
  const pf = gits('git pf origin HEAD:x', 'Bash', { resolveAlias })[0].git;
  assert.equal(pf.sub, 'push'); assert.deepEqual(pf.args, ['--force', 'origin', 'HEAD:x']); assert.equal(pf.certain, true);
  assert.deepEqual(asked, [['pf', base]]);
  const sh = gits('git sh', 'Bash', { resolveAlias });
  assert.equal(sh.at(-1).git.sub, 'push', 'a shell alias is parsed as a nested command');
  assert.equal(sh.at(-1).git.certain, false);
  asked.length = 0;
  gits('git status && git push origin HEAD:x && git commit -m y', 'Bash', { resolveAlias });
  assert.deepEqual(asked, [], 'built-in commands are never looked up');
  assert.equal(gits('git -c alias.push=status push origin HEAD:main', 'Bash')[0].git.sub, 'push', 'git ignores an alias that shadows a built-in');
});

// ---------------------------------------------------------------------------
// H19: backslash before a quote is an escape only in Bash
// ---------------------------------------------------------------------------

test('H19 grammar: PowerShell keeps a trailing backslash inside quotes; Bash escapes it', () => {
  const [g] = gits('Set-Location "C:\\repo\\"; git push --force origin HEAD:main', 'PowerShell');
  assert.ok(g, 'the push after a quoted path ending in a backslash is seen');
  assert.equal(g.git.sub, 'push'); assert.equal(g.cwd, 'C:\\repo');
  assert.equal(gits('Write-Host "a`"b"; git push origin HEAD:main', 'PowerShell')[0].git.sub, 'push', 'the PowerShell escape is the backtick');
  assert.equal(gits('bash -c "git commit -m \\"a b\\" && git push origin HEAD:x"', 'Bash').at(-1).git.sub, 'push', 'Bash unescapes \\" before the inner shell reads it');
  assert.deepEqual(shell.splitSegments('echo "a \\" b; c"'), ['echo "a \\" b; c"'], 'default keeps the old Bash rule for other callers');
});

// ---------------------------------------------------------------------------
// The two guards, as real processes
// ---------------------------------------------------------------------------

test('H1 guards: a push on another machine asks in both guards; main is still refused', async () => {
  const cwd = repo('h1-remote');
  for (const command of ['ssh pc2 "cd /repo && git push --force origin HEAD:feature/x"', 'ssh pc2 "cd /d C:\\r && git push"',
    "ssh pc2 bash -s <<'EOF'\ncd /repo\ngit push origin HEAD:feature/x\nEOF"]) {
    const p = await decide('policy-guard.js', command, { cwd, tool: 'Bash' });
    assert.equal(p.decision, 'ask', command); assert.match(p.reason, /runs a push on another machine; the local checks cannot cover it/, command);
    const s = await decide('precommit-guard.js', command, { cwd, tool: 'Bash' });
    assert.equal(s.decision, 'ask', command); assert.match(s.reason, /another machine/, command);
  }
  assert.equal((await decide('policy-guard.js', 'ssh pc2 "cd /repo && git push origin HEAD:main"', { cwd, tool: 'Bash' })).decision, 'deny');
});

test('H1 guards: a local push inside a here-document or pipe is judged like a plain push', async () => {
  const cwd = repo('h1-local');
  for (const command of ["bash <<'EOF'\ngit push origin HEAD:main\nEOF", "cat <<'EOF' | bash\ngit push origin HEAD:main\nEOF",
    'echo "git push origin HEAD:main" | sh', 'wsl -- git push origin HEAD:main']) {
    assert.equal((await decide('policy-guard.js', command, { cwd, tool: 'Bash' })).decision, 'deny', command);
  }
  const leak = leakyPush('h1-leak');
  const d = await decide('precommit-guard.js', "bash <<'EOF'\ngit push origin staging\nEOF", { cwd: leak, tool: 'Bash' });
  assert.equal(d.decision, 'deny'); assert.match(d.reason, /credential file/);
});

test('H1 guards: destructive commands nested in ssh or a here-document ask like local ones', async () => {
  const cwd = repo('h1-destroy');
  for (const command of ['ssh pc2 "docker compose down -v"', 'ssh pc2 "rm -rf /data/app"', 'ssh pc2 "git reset --hard"',
    'ssh pc2 "cd /d C:\\r && git clean -fdx"', 'ssh pc2 "docker volume prune -f"', "ssh pc2 'git branch -D old'",
    "docker exec -i db mysql -uroot <<'SQL'\nDROP TABLE Users;\nSQL", "mysql -uroot eduquest <<SQL\nTRUNCATE TABLE x;\nSQL",
    'ssh pc2 "docker exec -i eduquest-mysql mysql -uroot eduquest" <<\'SQL\'\nDELETE FROM Users;\nSQL',
    "bash <<'EOF'\nrm -rf src\nEOF", "ssh pc2 <<'EOF'\ngit reset --hard origin/staging\nEOF"]) {
    assert.equal((await decide('policy-guard.js', command, { cwd, tool: 'Bash' })).decision, 'ask', command);
  }
  assert.equal((await decide('policy-guard.js', 'ssh pc2 "rm -rf /"', { cwd, tool: 'Bash' })).decision, 'deny');
});

test('H1 guards: everyday remote and here-document commands stay allowed', async () => {
  const cwd = repo('h1-allowed');
  for (const command of ['ssh pc2 "dotnet test"', 'ssh pc2 "docker ps"', 'ssh -o ConnectTimeout=10 pc2 "cd /d C:\\repos\\app && dotnet build"',
    'timeout 590 ssh pc2 "cd /d C:/repos/app && dotnet test"', 'ssh -N -L 3000:localhost:3000 pc2', 'ssh pc2 "cd /d C:\\r && rd /s /q node_modules"',
    'ssh pc2 "git status --short && git log -1 --oneline"', "git commit -F - <<'EOF'\nfix: guard sees a nested push\nEOF",
    "cat > notes.md <<'EOF'\nthen git push --force and rm -rf src\nEOF", 'grep -n "git push" file.txt', "mysql -uroot <<'SQL'\nSELECT 1;\nSQL",
    'ssh pc2 "cd /d C:\\r && git fetch -q origin && git checkout -q --detach FETCH_HEAD"']) {
    for (const hook of ['policy-guard.js', 'precommit-guard.js']) {
      const d = await decide(hook, command, { cwd, tool: 'Bash' });
      assert.equal(d.decision, 'allow', hook + ': ' + command + ' → ' + d.reason);
      // A hang, not a speed test: under two suites at once one call took 6.9 s (2026-11-12).
      assert.ok(d.ms < 30000, 'does not hang: ' + d.ms + ' ms');
    }
  }
});

test('H18 guards: forced switches, find deletes and wrapped pushes are judged', async () => {
  const cwd = repo('h18');
  for (const command of ['git switch -f main', 'git switch --force main', 'git switch --discard-changes main', 'git checkout -f main',
    'find . -name "*.tmp" -delete', 'find . -type d -name x -exec rm -rf {} +', 'find src -execdir rm {} ;']) {
    assert.equal((await decide('policy-guard.js', command, { cwd, tool: 'Bash' })).decision, 'ask', command);
  }
  for (const command of ['timeout -k 5 600 git push origin HEAD:main', 'env -i git push origin HEAD:main', 'nice -n 10 git push origin HEAD:main',
    'nohup git push origin HEAD:main', 'winpty git push origin HEAD:main', 'stdbuf -oL git push origin HEAD:main', 'sudo -u me git push origin HEAD:main']) {
    const d = await decide('policy-guard.js', command, { cwd, tool: 'Bash' });
    assert.equal(d.decision, 'deny', command); assert.match(d.reason, /targets `main`/, command);
  }
  for (const command of ['timeout 600 dotnet test', 'find . -name x', 'find . -name "*.cs" -exec grep -l push {} +', 'git switch feature/x',
    'git switch -c feature/y', 'env FOO=1 dotnet build', 'nice -n 5 npm test']) {
    assert.equal((await decide('policy-guard.js', command, { cwd, tool: 'Bash' })).decision, 'allow', command);
  }
  const leak = leakyPush('h18-leak');
  assert.equal((await decide('precommit-guard.js', 'timeout -k 5 600 git push origin staging', { cwd: leak, tool: 'Bash' })).decision, 'deny');
});

test('H18 guards: saved git aliases are expanded; writing one that pushes asks', async () => {
  const cwd = repo('h18-alias');
  gitIn(cwd, 'config', 'alias.pf', 'push --force');
  gitIn(cwd, 'config', 'alias.st', 'status --short');
  gitIn(cwd, 'config', 'alias.ship', '!git push origin HEAD:main');
  const pf = await decide('policy-guard.js', 'git pf origin HEAD:main', { cwd, tool: 'Bash' });
  assert.equal(pf.decision, 'deny'); assert.match(pf.reason, /targets `main`/);
  assert.equal((await decide('policy-guard.js', 'git ship', { cwd, tool: 'Bash' })).decision, 'deny', 'a shell alias push cannot be checked');
  assert.equal((await decide('policy-guard.js', 'git st', { cwd, tool: 'Bash' })).decision, 'allow');
  for (const command of ['git config alias.pf2 "push --force"', 'git config --global alias.undo "reset --hard HEAD~1"', 'git config alias.wipe "clean -fdx"']) {
    assert.equal((await decide('policy-guard.js', command, { cwd, tool: 'Bash' })).decision, 'ask', command);
  }
  for (const command of ['git config alias.lg "log --oneline"', 'git config --get alias.pf', 'git config --unset alias.pf']) {
    assert.equal((await decide('policy-guard.js', command, { cwd, tool: 'Bash' })).decision, 'allow', command);
  }
  const leak = leakyPush('h18-alias-leak');
  gitIn(leak, 'config', 'alias.pub', 'push origin staging');
  assert.equal((await decide('precommit-guard.js', 'git pub', { cwd: leak, tool: 'Bash' })).decision, 'deny');
});

test('H19 guards: a PowerShell path ending in a backslash does not hide the push', async () => {
  const cwd = repo('h19');
  const leak = leakyPush('h19-leak');
  const p = await decide('policy-guard.js', 'Set-Location "' + cwd + '\\"; git push --force origin HEAD:main', { cwd });
  assert.equal(p.decision, 'deny'); assert.match(p.reason, /targets `main`/);
  const s = await decide('precommit-guard.js', 'Set-Location "' + leak + '\\"; git push origin staging', { cwd });
  assert.equal(s.decision, 'deny'); assert.match(s.reason, /credential file/);
});

test('H3 guard: a recursive delete of a git work tree asks, also in the temp folder', async () => {
  const cwd = repo('h3');
  const wtDir = path.join(fakeTemp, 'wt-folder'); fs.mkdirSync(path.join(wtDir, '.git'), { recursive: true }); fs.mkdirSync(path.join(wtDir, 'src'));
  const wtFile = path.join(fakeTemp, 'wt-file'); fs.mkdirSync(wtFile); fs.writeFileSync(path.join(wtFile, '.git'), 'gitdir: C:/x/.git/worktrees/y\n');
  const scratch = path.join(fakeTemp, 'scratchpad'); fs.mkdirSync(scratch);
  for (const [command, tool] of [['Remove-Item -Recurse -Force "' + wtDir + '"', 'PowerShell'], ['rm -rf ' + msys(wtFile), 'Bash'],
    ['cmd /c rmdir /s /q "' + wtFile + '"', 'PowerShell'], ['Remove-Item -Recurse -Force "' + path.join(wtDir, 'src') + '"', 'PowerShell']]) {
    const d = await decide('policy-guard.js', command, { cwd, tool });
    assert.equal(d.decision, 'ask', command);
  }
  const d = await decide('policy-guard.js', 'rm -rf ' + msys(wtDir), { cwd, tool: 'Bash' });
  assert.match(d.reason, /git work tree; unpushed work in it would be lost/);
  assert.equal((await decide('policy-guard.js', 'Remove-Item -Recurse -Force "' + scratch + '"', { cwd })).decision, 'allow', 'the scratchpad stays exempt');
  assert.ok(fs.existsSync(path.join(wtDir, '.git')), 'the hook never executes the command');
});

// ---------------------------------------------------------------------------
// The push gate with a scripted scan result (H8/H15) and a slow clock (H13)
// ---------------------------------------------------------------------------

const REPO = 'C:/repos/example';
const TP = 'C:/virtual/transcript.jsonl';
const TREE = '1'.repeat(40);
const receipt = (cwd, tree = TREE, toplevel = REPO) => ({ toplevel, treeBefore: tree, treeAfter: tree, cwd });
const passing = (over = {}) => ({
  lastEdit: 1, lastEditPath: REPO + '/src/App.cs', lastNonGitEdit: 1, lastNonRemoteEdit: 1, remoteCheckouts: [], passedTrees: [TREE],
  lastVerify: 2, lastVerifyResult: 2, lastFailedVerify: -1, lastPendingVerify: -1, lastCancelledVerify: -1, lastCancelledVerifyCommand: '',
  completedCheck: { cwd: REPO, source: { toplevel: REPO, treeBefore: TREE, treeAfter: TREE } }, lastBoundCheck: 2,
  lastReviewerRun: 3, lastReviewerResult: 4, lastReview: 5, lastReviewVerdict: 'PASS', lastReviewText: 'REVIEW: PASS', lastRangeDiff: -1,
  lastGate: 6, lastGateVerdict: 'PASS', lastProviderRun: -1, lastProviderResult: -1, lastFailedProvider: -1, lastPendingProvider: -1, ...over,
});
// Runs policy-guard in a sandbox: scripted git answers, a scripted scan, and a clock that each
// git call can move forward. No process, file or network is touched.
function gate({ command = 'git push origin feature/check', scan = passing(), codePaths = ['src/App.cs'], branch = 'feature/check', step = 0 } = {}) {
  const input = { cwd: REPO, transcript_path: TP, hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } };
  const clock = { now: 1_000_000 };
  const calls = [];
  const fakeFs = {
    readFileSync(p) { if (p === 0) return JSON.stringify(input); throw Error('Unexpected read: ' + p); },
    existsSync: (p) => p === TP,
    statSync() { throw Error('Unexpected stat'); },
  };
  const answer = (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return REPO;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return branch;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return TREE;
    if (args[0] === 'rev-parse' && String(args[2] || '').endsWith('^{commit}')) return 'a'.repeat(40);
    if (args[0] === 'rev-parse' && args.includes('--quiet')) return 'b'.repeat(40);
    if (args[0] === 'merge-base') return 'c'.repeat(40);
    if (args[0] === 'diff' && args.includes('--name-only')) return codePaths.join('\0') + '\0';
    if (args[0] === 'diff') return '';
    if (args[0] === 'ls-tree') return '100644 blob ' + '2'.repeat(40) + '\t' + args.at(-1);
    if (args[0] === 'status') return '';
    if (args[0] === 'config') throw Object.assign(Error('exit 1'), { status: 1 });
    throw Error('Unexpected git call: ' + args.join(' '));
  };
  let stdout = '';
  const halt = Symbol('exit');
  try {
    vm.runInNewContext(fs.readFileSync(path.join(hooks, 'policy-guard.js'), 'utf8').replace(/^#!.*/, ''), {
      __dirname: hooks, Buffer, Date: { now: () => clock.now },
      require(n) {
        if (n === 'fs') return fakeFs;
        if (n === 'path') return path;
        if (n === 'os') return { homedir: () => 'C:/Users/dev', tmpdir: () => 'C:/Users/dev/AppData/Local/Temp' };
        if (n.endsWith('shell-command.cjs')) return shell;
        if (n.endsWith('verification-target.cjs')) return require(path.join(hooks, 'lib', 'verification-target.cjs'));
        if (n.endsWith('transcript-scan.js')) return { scanTranscript: () => scan };
        if (n === 'child_process') return { execFileSync(exe, args) { calls.push(args.join(' ')); clock.now += step; return answer(args); } };
        throw Error('Unexpected require: ' + n);
      },
      process: { cwd: () => REPO, stdout: { write: (s) => { stdout += s; } }, exit: () => { throw halt; } },
    }, { timeout: 5000 });
  } catch (e) { if (e !== halt) throw e; }
  const h = (stdout ? JSON.parse(stdout) : {}).hookSpecificOutput || {};
  return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '', calls };
}

test('H8/H15 gate: without a receipt list the latest receipt still decides, as before', () => {
  assert.equal(gate().decision, 'allow');
  const other = passing({ completedCheck: { cwd: REPO, source: { toplevel: REPO, treeBefore: '9'.repeat(40), treeAfter: '9'.repeat(40) } } });
  assert.equal(gate({ scan: other }).decision, 'deny');
});

test('H15 gate: any passing receipt of this repository and exact tree counts, not only the latest', () => {
  const latestElsewhere = { cwd: REPO, source: { toplevel: 'C:/repos/other', treeBefore: '9'.repeat(40), treeAfter: '9'.repeat(40) } };
  const scan = passing({ completedCheck: latestElsewhere, passingReceipts: [receipt(REPO), receipt('C:/repos/other', '9'.repeat(40), 'C:/repos/other')] });
  assert.equal(gate({ scan }).decision, 'allow');
  assert.equal(gate({ scan: passing({ passingReceipts: [receipt('c:\\REPOS\\example', TREE, 'c:\\REPOS\\Example\\')] }) }).decision, 'allow', 'paths compare without case or slash style');
  const none = gate({ scan: passing({ passingReceipts: [receipt(REPO, '9'.repeat(40))] }) });
  assert.equal(none.decision, 'deny'); assert.match(none.reason, /completed evidence\.mjs check of this repository and the exact outgoing tree/);
  const half = gate({ scan: passing({ passingReceipts: [{ toplevel: REPO, treeBefore: '9'.repeat(40), treeAfter: TREE, cwd: REPO }] }) });
  assert.equal(half.decision, 'deny', 'a tree that changed during the check proves nothing');
});

test('H8 gate: each top-level folder with changed code needs a passing check that ran there', () => {
  const codePaths = ['EduQuest/EduQuest.Api/Program.cs', 'eduquest-frontend/src/App.tsx', 'docs/notes.md'];
  const backendOnly = gate({ codePaths, scan: passing({ passingReceipts: [receipt(REPO + '/EduQuest/EduQuest.Tests')] }) });
  assert.equal(backendOnly.decision, 'deny');
  assert.match(backendOnly.reason, /no passing check ran in eduquest-frontend\/ for this code/);
  assert.equal(gate({ codePaths, scan: passing({ passingReceipts: [receipt(REPO + '/EduQuest'), receipt(REPO + '/eduquest-frontend')] }) }).decision, 'allow');
  assert.equal(gate({ codePaths, scan: passing({ passingReceipts: [receipt(REPO)] }) }).decision, 'allow', 'a check from the repository root covers every folder');
  assert.equal(gate({ codePaths: ['build.ps1', 'Directory.Build.props'], scan: passing({ passingReceipts: [receipt(REPO + '/tools')] }) }).decision, 'allow', 'root-level code needs any matching receipt');
  const wrongTree = gate({ codePaths, scan: passing({ passingReceipts: [receipt(REPO + '/EduQuest'), receipt(REPO + '/eduquest-frontend', '9'.repeat(40))] }) });
  assert.match(wrongTree.reason, /no passing check ran in eduquest-frontend\//, 'a receipt of another tree covers no folder');
  assert.equal(gate({ codePaths: ['docs/a.md'], scan: passing({ passingReceipts: [] }) }).decision, 'allow', 'prose-only pushes need no check');
});

test('H13 gate: a push check that runs out of its time budget is refused; other commands keep their answer', () => {
  const slow = gate({ step: 7000 });
  assert.equal(slow.decision, 'deny');
  assert.match(slow.reason, /the push check ran out of time; run the push again/);
  assert.ok(slow.calls.length <= 4, 'no git call starts after the budget is spent: ' + slow.calls.length);
  assert.equal(gate({ step: 900 }).decision, 'allow', 'a slow but finished check keeps its verdict');
  assert.equal(gate({ command: 'git merge feature/x', branch: 'staging', step: 7000 }).decision, 'ask');
  assert.equal(gate({ command: 'dotnet test', step: 7000 }).decision, 'allow');
});

describe('guard nested commands', { concurrency: 4 }, () => {
  for (const [name, fn] of queued) it(name, fn);
});
